#!/bin/sh
if [ -n "$MATE_EDITOR" ]; then
  datestr=`date "+%s"`
  filebase=`basename "$1"`
  fname="remoteedit_${datestr}_${filebase}"
  port=$MATE_EDITOR
  scp -P $port "$1" "localhost:'/tmp/$fname'"
  ssh -t -p $port localhost "mate --wait '/tmp/$fname'"
  scp -P $port "localhost:'/tmp/$fname'" "$1"
  ssh -p $port localhost "rm '/tmp/$fname'"
else
  vim "$1"
fi
