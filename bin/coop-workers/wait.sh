#!/bin/bash
# wait.sh NAME: waits for coop's ~/coop-workers/NAME.result (supervise.sh), then prints it with the notes
n=$1
while ! ssh -o ClearAllForwardings=yes -o ConnectTimeout=10 coop "test -f ~/coop-workers/$n.result" 2>/dev/null; do sleep 60; done
ssh -o ClearAllForwardings=yes coop "echo result: \$(cat ~/coop-workers/$n.result); cat ~/coop-workers/$n.supervise; tail -c 1000 ~/coop-workers/$n.err"
