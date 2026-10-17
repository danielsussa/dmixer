#!/bin/sh
# Gera as mídias do exemplo com ffmpeg (sem downloads): uma "voz" (tons curtos) e uma "música" (acorde contínuo).
set -e
cd "$(dirname "$0")/audio"
ffmpeg -v error -y -f lavfi -i "sine=f=220:d=2" -f lavfi -i "sine=f=330:d=2" -filter_complex "[0][1]amix=2,volume=0.8,afade=t=in:d=0.05,afade=t=out:st=1.9:d=0.1" fala-1.wav
ffmpeg -v error -y -f lavfi -i "sine=f=262:d=3" -filter_complex "volume=0.8,afade=t=in:d=0.05,afade=t=out:st=2.9:d=0.1" fala-2.wav
ffmpeg -v error -y -f lavfi -i "sine=f=147:d=14" -f lavfi -i "sine=f=185:d=14" -f lavfi -i "sine=f=220:d=14" -filter_complex "[0][1][2]amix=3,volume=0.6" musica.wav
# um vídeo de teste: 14 s com o tempo escrito na tela (sem som)
ffmpeg -v error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=14" -vf "drawtext=text='%{pts\:hms}':fontsize=72:fontcolor=white:x=40:y=40:box=1:boxcolor=black@0.5" -c:v libx264 -pix_fmt yuv420p -preset veryfast imagem.mp4
