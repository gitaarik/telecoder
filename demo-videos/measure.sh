#!/bin/bash
# Bursts of redrawing left in the Telegram chat of a composed video.
# A 1920-wide video has the wide layout: the chat is the right part of the Telegram pane.
w=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of csv=p=0 "$1")
if [ "$w" = 1920 ]; then crop=564:1000:396:20; min=0.004; else crop=640:1000:20:20; min=0.02; fi
ffmpeg -v error -i "$1" -vf "crop=$crop,select='gte(scene,0)',metadata=print:key=lavfi.scene_score:file=-" -f null - 2>/dev/null | paste - - | awk -v m=$min '{split($3,t,":"); split($4,v,"="); if (v[2]>m) print t[2]}' | python3 -c "
import sys
ts=[float(l) for l in sys.stdin]; b=[]
for t in ts:
    if b and t-b[-1][-1]<0.6: b[-1].append(t)
    else: b.append([t])
print('bursts left:', [(round(x[0],2),len(x)) for x in b if len(x)>1 and x[-1]-x[0]<2.5])"
