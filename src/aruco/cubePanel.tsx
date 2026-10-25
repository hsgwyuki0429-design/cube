// キューブモードの結果: 推定した手順（色基準・持ち方基準）、正解との比較、面の組み立ての様子
import { FACES, MOVE_NAMES, cameraFaceOf, moveFace, parseMoves } from "../cube/model";
import { simplifyMoves } from "../track/merge";
import type { DecodedMove } from "../track/types";
import { Cube3D } from "../ui/Cube3D";
import type { CubeResult, VisibleFace } from "./cube";
import { stickerName } from "./stickers";

// 面の展開図のセルの表示名: 54 種類はステッカー（U0 など）、12 種類は位置が分からないので空

export const SLOT_NAMES = ["上", "右", "正面", "下", "左"];
const CSS_COLORS = ["#f2f2f2", "#d1263a", "#16a05a", "#f5d000", "#ff7a1a", "#2563d9"];

const suffix = (m: number) => ["", "2", "'"][m % 3];
// 持ち方基準: その手のときにカメラから見てどの面か（正面 = F、上 = U …）
export const heldName = (m: DecodedMove) => FACES[cameraFaceOf(m.orient, moveFace(m.move))] + suffix(m.move);

export interface TruthCompare {
  error: string | null;
  truth: string[];
  decoded: string[];
  distance: number; // 編集距離（手の数）
  exact: boolean;
}

export function compareTruth(text: string, moves: DecodedMove[]): TruthCompare | null {
  if (!text.trim()) return null;
  const decoded = moves.map((m) => MOVE_NAMES[m.move]);
  let parsed: number[];
  try {
    parsed = parseMoves(text.replace(/[()]/g, " "));
  } catch {
    return { error: "読めない手があります（使えるのは U R F D L B と 2・'。持ち替え・中層・2 層回しは未対応）", truth: [], decoded, distance: 0, exact: false };
  }
  const truth = simplifyMoves(parsed.map((move) => ({ move, t: 0, orient: 0 }))).map((m) => MOVE_NAMES[m.move]);
  const n = truth.length;
  const k = decoded.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: k + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= n; i++) for (let j = 1; j <= k; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (truth[i - 1] === decoded[j - 1] ? 0 : 1));
  return { error: null, truth, decoded, distance: d[n][k], exact: d[n][k] === 0 };
}

export function CubeResults({ result, truthText, onTruth }: { result: CubeResult; truthText: string; onTruth: (s: string) => void }) {
  const cmp = compareTruth(truthText, result.moves);
  const moves = result.moves;
  const first = moves[0];
  const lastMove = moves[moves.length - 1];
  const span = first && lastMove ? (lastMove.t - (first.t0 ?? first.t)) / 1000 : 0;
  return (
    <div class="card section">
      <div class="card-head">2. 推定した手順</div>
      <div class="card-body">
        {moves.length ? (
          <>
            <div class="alg">{moves.map((m) => <span class={m.inferred ? "inferred" : ""}>{MOVE_NAMES[m.move]}</span>)}</div>
            <p class="hint">
              色基準（白 = U・緑 = F の面）。{moves.length} 手
              {span > 0 ? `・${span.toFixed(2)} 秒（${(moves.length / span).toFixed(1)} 手/秒）` : ""}
              {moves.some((m) => m.inferred) ? "・薄い字 = 直接は見えず、前後の辻褄から推定した手" : ""}
            </p>
            <div class="alg small">{moves.map((m) => <span class={m.inferred ? "inferred" : ""}>{heldName(m)}</span>)}</div>
            <p class="hint">持ち方基準（その手のとき、カメラから見た正面 = F・上 = U）</p>
            <div class="cube-replay">
              <Cube3D key={moves.map((m) => m.move).join(",")} epoch={0} setupMoves={[]} moves={[]} orient={null} controls setupAlg="" alg={moves.map((m) => MOVE_NAMES[m.move]).join(" ")} />
            </div>
            <p class="hint">推定した手順の再生（揃った状態から。色基準・白が上・緑が正面）。ドラッグで回して見られます</p>
          </>
        ) : (
          <div class="status-banner warn">手を見つけられませんでした（面が組み立てられたフレームが少ないか、回していない）。</div>
        )}
        <label>
          正解の手順（任意。比べます）
          <input type="text" placeholder="例: R U R' U' R' F R2 U' R' U' R U R' F'" value={truthText} onInput={(e) => onTruth((e.target as HTMLInputElement).value)} />
        </label>
        {cmp &&
          (cmp.error ? (
            <div class="hint bad">{cmp.error}</div>
          ) : (
            <div class={`status-banner ${cmp.exact ? "ok" : "bad"}`}>
              <strong>{cmp.exact ? "正解と一致" : `正解と ${cmp.distance} 手違う`}</strong>
              正解（まとめた後）: {cmp.truth.join(" ")}
            </div>
          ))}
        <div class="scroll">
          <table class="list">
            <tbody>
              <tr>
                <td>解析したフレーム</td>
                <td>{result.frames}</td>
              </tr>
              <tr>
                <td>面を組み立てられたフレーム</td>
                <td>
                  {result.framesWithFace}（{((100 * result.framesWithFace) / Math.max(1, result.frames)).toFixed(1)}%）
                </td>
              </tr>
              <tr>
                <td>観測（見え方が変わった回数）</td>
                <td>{result.observations}</td>
              </tr>
              <tr>
                <td>つなぎ方</td>
                <td>
                  {result.method}
                  {result.method === "meet" || result.method === "bridge" ? "（揃った状態から前向き・最後の状態から後ろ向きをつないだ）" : ""}
                  {!result.reachedEnd ? "・最後に揃った状態にたどり着けなかった" : ""}
                </td>
              </tr>
              <tr>
                <td>推定にかかった時間</td>
                <td>{result.ms.toFixed(0)} ms</td>
              </tr>
            </tbody>
          </table>
        </div>
        {moves.length > 0 && (
          <details class="section">
            <summary>手ごとの時刻</summary>
            <div class="scroll">
              <table class="list">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>色基準</th>
                    <th>持ち方基準</th>
                    <th>回し始め〜回し終わり（秒）</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m, i) => (
                    <tr>
                      <td>{i + 1}</td>
                      <td>{MOVE_NAMES[m.move]}</td>
                      <td>{heldName(m)}</td>
                      <td>
                        {m.t0 !== undefined ? (m.t0 / 1000).toFixed(3) : "—"} 〜 {(m.t / 1000).toFixed(3)}
                      </td>
                      <td>{m.inferred ? "推定" : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

// いま表示しているフレームで組み立てた面（展開図: 上 / 左・正面・右 / 下）
export function FaceNet({ faces }: { faces: VisibleFace[] }) {
  const pos: Record<number, [number, number]> = { 0: [1, 2], 4: [2, 1], 2: [2, 2], 1: [2, 3], 3: [3, 2] };
  return (
    <div class="facenet">
      {[0, 4, 2, 1, 3].map((slot) => {
        const f = faces.find((x) => x.slot === slot);
        return (
          <div class="face" style={{ gridRow: pos[slot][0], gridColumn: pos[slot][1] }}>
            <div class="face-label">{SLOT_NAMES[slot]}</div>
            {Array.from({ length: 9 }, (_, cell) => {
              const color = f ? f.colors[cell] : -1;
              const id = f ? f.ids[cell] : -1;
              return (
                <div class="cell" style={color >= 0 ? { background: CSS_COLORS[color] } : undefined} title={id >= 0 ? stickerName(id) : ""}>
                  {id >= 0 ? stickerName(id) : ""}
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
