#!/usr/bin/env bash
# Live checks against a running dev server: BASE=http://127.0.0.1:3000 bash live-checks.sh
set -u
BASE=${BASE:-http://127.0.0.1:3000}
fail=0
check() { if eval "$2"; then echo "PASS $1"; else echo "FAIL $1"; fail=1; fi; }
J=$(curl -s -m 180 "$BASE/api/quant/BBCA.JK?refresh=1")
check "AC-9 name"      '[[ $(echo "$J" | node -pe "JSON.parse(require(\"fs\").readFileSync(0)).name") == *"Bank Central Asia"* ]]'
check "AC-9 currency"  '[[ $(echo "$J" | node -pe "JSON.parse(require(\"fs\").readFileSync(0)).currency") == IDR ]]'
check "AC-9 benchmark" '[[ $(echo "$J" | node -pe "JSON.parse(require(\"fs\").readFileSync(0)).benchmark.symbol") == "^JKSE" ]]'
check "AC-9 value"     '[[ $(echo "$J" | node -pe "const s=JSON.parse(require(\"fs\").readFileSync(0)); s.value ? \"ok\" : (s.value_reason||\"\")") != "" ]]'
F=$(curl -s -m 60 "$BASE/api/quant-finder?q=BBCA")
check "AC-9 finder"    '[[ "$F" == *"BBCA.JK"* ]]'
A=$(curl -s -m 30 "$BASE/api/assets")
check "AC-2 symbols"   '[[ "$A" == *"\"symbols\""* ]]'
W=$(curl -s -m 30 -X POST -H "Origin: $BASE" -H "Content-Type: application/json" -d '{"ticker":"bbca.jk","name":"PT Bank Central Asia Tbk"}' "$BASE/api/watchlist")
check "AC-14 add"      '[[ "$W" == *"BBCA.JK"* ]]'
L=$(curl -s -m 30 "$BASE/api/watchlist")
check "AC-14 list"     '[[ "$L" == *"BBCA.JK"* ]]'
curl -s -m 30 -X DELETE -H "Origin: $BASE" "$BASE/api/watchlist/BBCA.JK" >/dev/null
L2=$(curl -s -m 30 "$BASE/api/watchlist")
check "AC-14 remove"   '[[ "$L2" != *"BBCA.JK"* ]]'
S=$(curl -s -m 30 "$BASE/api/settings/models")
check "AC-16 no secret" '[[ "$S" != *"sk-"* && "$S" == *"secrets"* ]]'
exit $fail
