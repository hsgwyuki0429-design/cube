;; 専用のマーカー検出（src/aruco/quadDetect.ts）の二値化。明るさ v（1 画素 1 バイト、行の幅 vs: w より 8 以上広く、余りは 0）を、
;; まわり win × win の平均より c 以上暗い画素を 1 にしたビット列（行の幅 stride バイト、画素 x は x >> 3 バイト目の x & 7 ビット）にする。
;; 窓の中の和は、列ごとの縦の和（16 ビット。行が進むたびに 1 行足して 1 行引く）を横に win 個足して作る。8 画素ずつ（SIMD）。
;; 上下の half 行・左の 8 列は 0（暗くない）のまま。右の端は窓が画像の外（0）にかかるので暗くなりにくい。
;; win は 15 まで（(255 + c) × win² と窓の和が 16 ビットに収まること）。
;;   node scripts/wasm/build.mjs で src/aruco/threshWasm.ts を作り直す
(module
  (memory (export "mem") 48)
  (func (export "thresh")
    (param $v i32) (param $vs i32) (param $w i32) (param $h i32) (param $win i32) (param $c i32)
    (param $col i32) (param $mask i32) (param $stride i32)
    (local $half i32) (local $y i32) (local $x i32) (local $p i32) (local $k i32) (local $r i32) (local $m i32) (local $rowV i32)
    (local $sum v128) (local $area v128) (local $cv v128)
    (local.set $half (i32.shr_u (local.get $win) (i32.const 1)))
    (local.set $area (i16x8.splat (i32.mul (local.get $win) (local.get $win))))
    (local.set $cv (i16x8.splat (local.get $c)))
    ;; 列の和（w + 32 個）とビット列を 0 に
    (memory.fill (local.get $col) (i32.const 0) (i32.shl (i32.add (local.get $w) (i32.const 32)) (i32.const 1)))
    (memory.fill (local.get $mask) (i32.const 0) (i32.mul (local.get $h) (local.get $stride)))
    (if (i32.lt_s (local.get $h) (local.get $win)) (then (return)))
    ;; 最初の win - 1 行を足しておく
    (local.set $y (i32.const 0))
    (block $initDone
      (loop $init
        (br_if $initDone (i32.ge_s (local.get $y) (i32.sub (local.get $win) (i32.const 1))))
        (local.set $r (i32.add (local.get $v) (i32.mul (local.get $y) (local.get $vs))))
        (local.set $x (i32.const 0))
        (loop $ax
          (local.set $p (i32.add (local.get $col) (i32.shl (local.get $x) (i32.const 1))))
          (v128.store align=1 (local.get $p)
            (i16x8.add (v128.load align=1 (local.get $p)) (v128.load8x8_u align=1 (i32.add (local.get $r) (local.get $x)))))
          (local.set $x (i32.add (local.get $x) (i32.const 8)))
          (br_if $ax (i32.lt_s (local.get $x) (local.get $w))))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $init)))
    (local.set $y (local.get $half))
    (block $done
      (loop $rows
        (br_if $done (i32.ge_s (local.get $y) (i32.sub (local.get $h) (local.get $half))))
        ;; 行 y + half を足す
        (local.set $r (i32.add (local.get $v) (i32.mul (i32.add (local.get $y) (local.get $half)) (local.get $vs))))
        (local.set $x (i32.const 0))
        (loop $ax2
          (local.set $p (i32.add (local.get $col) (i32.shl (local.get $x) (i32.const 1))))
          (v128.store align=1 (local.get $p)
            (i16x8.add (v128.load align=1 (local.get $p)) (v128.load8x8_u align=1 (i32.add (local.get $r) (local.get $x)))))
          (local.set $x (i32.add (local.get $x) (i32.const 8)))
          (br_if $ax2 (i32.lt_s (local.get $x) (local.get $w))))
        ;; 行 y - half - 1 を引く
        (if (i32.gt_s (local.get $y) (local.get $half))
          (then
            (local.set $r (i32.add (local.get $v) (i32.mul (i32.sub (i32.sub (local.get $y) (local.get $half)) (i32.const 1)) (local.get $vs))))
            (local.set $x (i32.const 0))
            (loop $sx
              (local.set $p (i32.add (local.get $col) (i32.shl (local.get $x) (i32.const 1))))
              (v128.store align=1 (local.get $p)
                (i16x8.sub (v128.load align=1 (local.get $p)) (v128.load8x8_u align=1 (i32.add (local.get $r) (local.get $x)))))
              (local.set $x (i32.add (local.get $x) (i32.const 8)))
              (br_if $sx (i32.lt_s (local.get $x) (local.get $w))))))
        ;; この行の二値化（x = 8 から 8 画素ずつ）
        (local.set $rowV (i32.add (local.get $v) (i32.mul (local.get $y) (local.get $vs))))
        (local.set $m (i32.add (local.get $mask) (i32.mul (local.get $y) (local.get $stride))))
        (local.set $x (i32.const 8))
        (block $rowDone
          (loop $tx
            (br_if $rowDone (i32.ge_s (local.get $x) (local.get $w)))
            (local.set $p (i32.add (local.get $col) (i32.shl (i32.sub (local.get $x) (local.get $half)) (i32.const 1))))
            (local.set $sum (v128.load align=1 (local.get $p)))
            (local.set $k (i32.const 1))
            (loop $kx
              (local.set $sum (i16x8.add (local.get $sum) (v128.load align=1 (i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 1))))))
              (local.set $k (i32.add (local.get $k) (i32.const 1)))
              (br_if $kx (i32.lt_s (local.get $k) (local.get $win))))
            (i32.store8 (i32.add (local.get $m) (i32.shr_u (local.get $x) (i32.const 3)))
              (i16x8.bitmask
                (i16x8.lt_u
                  (i16x8.mul (i16x8.add (v128.load8x8_u align=1 (i32.add (local.get $rowV) (local.get $x))) (local.get $cv)) (local.get $area))
                  (local.get $sum))))
            (local.set $x (i32.add (local.get $x) (i32.const 8)))
            (br $tx)))
        (local.set $y (i32.add (local.get $y) (i32.const 1)))
        (br $rows)))))
