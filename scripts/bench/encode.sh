#!/bin/bash
# 本体の録画の画質（CLAUDE.md の ffmpeg の条件）で 5・2.5・1.5Mbps に。-threads 1: x264 を毎回同じ結果にする
BENCH=${BENCH:-/home/user/bench}
cd $BENCH && mkdir -p enc
for v in videos/*; do
  n=$(basename $v); n=${n%.*}
  for b in 5000 2500 1500; do
    o=enc/${n}_${b}k.mp4
    [ -f $o ] && continue
    ffmpeg -v error -y -i $v -vf scale=1280:-2 -r 60 -c:v libx264 -profile:v baseline -preset veryfast -tune zerolatency -b:v ${b}k -maxrate ${b}k -bufsize $((b/2))k -g 60 -pix_fmt yuv420p -threads 1 $o
  done
done
