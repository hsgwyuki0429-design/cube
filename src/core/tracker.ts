/**
 * 追跡エンジン。CLAUDE.md「追跡アルゴリズム仕様」の実装。
 *
 * カメラも DOM も知らない。入力は「ROIごとの色ラベル + 信頼度」だけ。
 * これによりリプレイ（カメラなし再実行）と回帰テストが同じコードを通る。
 *
 * 映像から手順を組み立てるのではなく、常に
 *   「候補手を状態機械に適用し、予測される見え方と照合する」
 * 方向で解く（アーキテクチャ原則 §2）。
 */

import {
  applyMove, applySequence, getFaceletsInto, solvedState, isSolved,
  MOVES_18, ROTATIONS_6, type CubeState, type FaceIndex,
} from './cube';

export type TrackStatus = 'TRACKING' | 'TRANSITION' | 'LOST';

/** 恒等候補の表記。手順ログには残さない。 */
export const IDENTITY = '.';

/** 恒等 + 18手 + 6全体回転 = 25 候補。 */
export const CANDIDATES: readonly string[] = [IDENTITY, ...MOVES_18, ...ROTATIONS_6];
/** 2手同時展開で2手目に使う候補（恒等を除く24）。 */
const SECOND_MOVES: readonly string[] = [...MOVES_18, ...ROTATIONS_6];

export interface TrackerThresholds {
  /** 最良スコアがこれを超えないと採用しない */
  scoreThreshold: number;
  /** 2位（異なる予測をする候補）との差がこれを超えないと採用しない */
  marginThreshold: number;
  /** 非恒等候補を確定させるのに必要な連続フレーム数 */
  hysteresisFrames: number;
  /** TRANSITION がこのフレーム数続いたら LOST */
  lostFrames: number;
  /** これ未満の信頼度のセルはスコアに使わない（見えていない扱い） */
  minCellConf: number;
  /** 可視セルがこれ未満のフレームは判定しない */
  minVisibleCells: number;
  /** 2手同時展開（既定 OFF） */
  twoMoveEnabled: boolean;
  /** 2手展開時、1手目のスコア上位いくつまで展開するか */
  twoMoveTopK: number;
  /**
   * 観測が「何も起きていない」と区別できない場合に恒等を採るか。
   * OFF にすると曖昧なフレームは全て TRANSITION になる（より正直だが LOST が増える）。
   */
  preferIdentityOnTie: boolean;
}

export function defaultThresholds(): TrackerThresholds {
  return {
    scoreThreshold: 0.85,
    marginThreshold: 0.05,
    hysteresisFrames: 2,
    lostFrames: 30,
    minCellConf: 0.15,
    minVisibleCells: 6,
    twoMoveEnabled: false,
    twoMoveTopK: 5,
    preferIdentityOnTie: true,
  };
}

/** 1枚の ROI の観測。 */
export interface RoiObservation {
  face: FaceIndex;
  labels: ArrayLike<number>;
  conf: ArrayLike<number>;
}

export interface CandidateScore {
  /** "R" や "R U'"（2手同時）や "." */
  label: string;
  score: number;
  /** 同じ見え方をする候補が他にもあるか（曖昧さの可視化） */
  aliases: string[];
}

export interface AppliedMove {
  notation: string;
  /** 記録開始からの経過 ms */
  t: number;
  /** 採用時のスコア */
  confidence: number;
}

export interface TrackerStep {
  status: TrackStatus;
  /** このフレームで確定した手。複数手同時なら複数入る */
  applied: string[];
  candidates: CandidateScore[];
  best: number;
  margin: number;
  visibleCells: number;
  /** 曖昧（同点の別候補が複数ありどれとも決められない）だったか */
  ambiguous: boolean;
}

interface ScoredGroup {
  key: string;
  score: number;
  members: string[];
}

export class Tracker {
  state: CubeState;
  status: TrackStatus = 'TRACKING';
  thresholds: TrackerThresholds;
  readonly moves: AppliedMove[] = [];

  /** 統計 */
  lostCount = 0;
  frameCount = 0;
  transitionFrames = 0;

  private pending: { label: string; count: number } | null = null;
  private consecutiveTransition = 0;
  private buf: FaceIndex[] = new Array(9);
  /** 候補状態のキャッシュ（1フレーム内で使い捨て） */
  private scratch: Map<string, CubeState> = new Map();

  constructor(state: CubeState = solvedState(), thresholds = defaultThresholds()) {
    this.state = state;
    this.thresholds = thresholds;
  }

  reset(state: CubeState = solvedState()): void {
    this.state = state;
    this.status = 'TRACKING';
    this.moves.length = 0;
    this.pending = null;
    this.consecutiveTransition = 0;
    this.lostCount = 0;
    this.frameCount = 0;
    this.transitionFrames = 0;
  }

  get solved(): boolean {
    return isSolved(this.state);
  }

  /**
   * 候補状態を ROI に投影したときの予測ラベル列と、その一致スコアを返す。
   * スコア = Σ(信頼度 × 一致) / Σ(信頼度)、可視セルのみで正規化。
   */
  private scoreState(s: CubeState, obs: RoiObservation[], minConf: number): { score: number; key: string } {
    let num = 0;
    let den = 0;
    let key = '';
    for (const o of obs) {
      getFaceletsInto(s, o.face, this.buf);
      for (let i = 0; i < 9; i++) {
        const c = o.conf[i];
        const l = o.labels[i];
        if (l < 0 || c < minConf) {
          key += '-';
          continue;
        }
        key += String(this.buf[i]);
        den += c;
        if (this.buf[i] === l) num += c;
      }
    }
    return { score: den > 0 ? num / den : 0, key };
  }

  private candidateState(label: string): CubeState {
    let s = this.scratch.get(label);
    if (!s) {
      s = label === IDENTITY ? this.state : applySequence(this.state, label);
      this.scratch.set(label, s);
    }
    return s;
  }

  /** 1フレーム分の観測を処理する。 */
  step(obs: RoiObservation[], t: number): TrackerStep {
    const th = this.thresholds;
    this.frameCount++;
    this.scratch.clear();

    let visible = 0;
    for (const o of obs) {
      for (let i = 0; i < 9; i++) if (o.labels[i] >= 0 && o.conf[i] >= th.minCellConf) visible++;
    }

    if (visible < th.minVisibleCells) {
      return this.transition([], 0, 0, visible, false);
    }

    // --- 単手候補 ---
    const scored: { label: string; score: number; key: string }[] = CANDIDATES.map((label) => {
      const { score, key } = this.scoreState(this.candidateState(label), obs, th.minCellConf);
      return { label, score, key };
    });
    scored.sort((a, b) => b.score - a.score || (a.label === IDENTITY ? -1 : b.label === IDENTITY ? 1 : 0));

    // --- 2手同時展開（オプション） ---
    if (th.twoMoveEnabled) {
      const seeds = scored.filter((c) => c.label !== IDENTITY).slice(0, th.twoMoveTopK);
      for (const seed of seeds) {
        const base = this.candidateState(seed.label);
        for (const m2 of SECOND_MOVES) {
          const label = `${seed.label} ${m2}`;
          const { score, key } = this.scoreState(applyMove(base, m2), obs, th.minCellConf);
          scored.push({ label, score, key });
        }
      }
      scored.sort((a, b) => b.score - a.score || (a.label === IDENTITY ? -1 : b.label === IDENTITY ? 1 : 0));
    }

    // --- 同じ見え方をする候補をまとめる ---
    // 可視面だけでは区別できない候補が必ず存在する。これを別候補として扱うと
    // マージン判定が常に落ちて静止中でも LOST になるため、予測が同一のものは1つにする。
    const groups: ScoredGroup[] = [];
    const byKey = new Map<string, ScoredGroup>();
    for (const c of scored) {
      let g = byKey.get(c.key);
      if (!g) {
        g = { key: c.key, score: c.score, members: [] };
        byKey.set(c.key, g);
        groups.push(g);
      }
      g.members.push(c.label);
    }
    groups.sort((a, b) => b.score - a.score);

    const bestGroup = groups[0];
    const best = bestGroup.score;
    const margin = groups.length > 1 ? best - groups[1].score : 1;

    const candidates: CandidateScore[] = groups.slice(0, 5).map((g) => ({
      label: g.members[0],
      score: g.score,
      aliases: g.members.slice(1),
    }));

    // --- 採用判定 ---
    if (best <= th.scoreThreshold || margin <= th.marginThreshold) {
      return this.transition(candidates, best, margin, visible, false);
    }

    const hasIdentity = bestGroup.members.includes(IDENTITY);
    let chosen: string | null = null;
    let ambiguous = false;
    if (hasIdentity) {
      // 「何も起きていない」と矛盾しない観測。既定ではこれを採る。
      if (th.preferIdentityOnTie || bestGroup.members.length === 1) chosen = IDENTITY;
      else ambiguous = true;
    } else if (bestGroup.members.length === 1) {
      chosen = bestGroup.members[0];
    } else {
      ambiguous = true;
    }

    if (chosen === null) return this.transition(candidates, best, margin, visible, ambiguous);

    if (chosen === IDENTITY) {
      this.pending = null;
      this.consecutiveTransition = 0;
      this.status = 'TRACKING';
      return { status: 'TRACKING', applied: [], candidates, best, margin, visibleCells: visible, ambiguous: false };
    }

    // 非恒等はヒステリシス（連続 N フレーム同一）で確定
    if (this.pending && this.pending.label === chosen) this.pending.count++;
    else this.pending = { label: chosen, count: 1 };

    if (this.pending.count < th.hysteresisFrames) {
      // 確定前。状態は保持したまま TRANSITION 扱いにはしない（回転途中ではなく確認中）
      this.consecutiveTransition = 0;
      return { status: this.status, applied: [], candidates, best, margin, visibleCells: visible, ambiguous: false };
    }

    const applied = chosen.split(' ');
    for (const m of applied) {
      this.state = applyMove(this.state, m);
      this.moves.push({ notation: m, t, confidence: best });
    }
    this.pending = null;
    this.consecutiveTransition = 0;
    this.status = 'TRACKING';
    return { status: 'TRACKING', applied, candidates, best, margin, visibleCells: visible, ambiguous: false };
  }

  private transition(
    candidates: CandidateScore[], best: number, margin: number, visible: number, ambiguous: boolean,
  ): TrackerStep {
    this.transitionFrames++;
    this.consecutiveTransition++;
    this.pending = null;
    if (this.consecutiveTransition >= this.thresholds.lostFrames) {
      if (this.status !== 'LOST') this.lostCount++;
      this.status = 'LOST';
    } else if (this.status !== 'LOST') {
      this.status = 'TRANSITION';
    }
    return { status: this.status, applied: [], candidates, best, margin, visibleCells: visible, ambiguous };
  }
}
