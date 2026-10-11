# GBIS 30 direction split diagnosis

Local emulator query on 2026-10-11 (Asia/Seoul), selected route `229000010`: route `30`, 일반형시내버스, detail start 적성차고지 and detail end 양광교회, region `고양,서울,파주`. The normalized, key-free snapshot is [`goyang-30-sanitized.json`](../../scripts/fixtures/goyang-30-sanitized.json). It contains route detail, 245 ordered stop visits, and 2,836 shape points. It contains no vehicle data or API key. The last listed visit is 적성삼거리, so the detail endpoint's end name is not a substitute for the last stop visit. Eleven stop IDs recur at different sequences, and 209 exact shape coordinates recur. One turn visit is marked: sequence 123, stop `111000165` (양광교회). Its nearest shape projection is index 1422.116 at 8.38 m, so the existing split boundary remains index 1423.

Before the fix, `splitRouteDirections()` returned “정류장 방문 순서와 형상의 진행 순서가 일치하지 않습니다.” The first outbound rejection was visit 31, `229000239` (법원리우체국). The old nearest projection was index 388.975, 9.26 m from the stop; another plausible projection was index 465.079, 15.09 m away and 2,322.6 m later along the shape. The old rule rejected any such pair immediately. Visits 32–35 follow indices 390.986, 394.974, 398.920, and 405.886, so the later index 465 cannot represent visit 31 in this stop order. The first inbound rejection was visit 131, `277101905` (구파발역 경유). The old nearest projection, index 1503.010 at 6.28 m, precedes visit 130's index 1517. The almost equally close index 1532.155 at 6.39 m follows visit 130 and precedes visit 132 at 1545.043. Both errors arise from a per-stop nearest choice that ignores the other visits, rather than absent GBIS shape data or an unmarked turn.

The corrected matcher keeps projections within the existing 35 m stop distance limit and within 10 m of the nearest projection, then retains only candidate chains that increase with the official visit order. It does not alter the GBIS shape, the turn, or the vehicle section verifier. For this snapshot, it yields shape ranges `0–1423` and `1423–2835`, and stop ranges `1–123` and `123–245`.

Two visits still have more than one plausible position **within their assigned direction**: visit 36 (indices about 418.837 and 434.124) and return visit 211 (about 2421.837 and 2437.124). The two points of each pair are about 283 m apart along the shape. The official stop list and shape alone do not prove on which pass the bus serves that stop. `verifiedRoadSection()` rejects synthetic verified vehicles on sections 35–36 and 210–211 with `ambiguous_loop`; the splitter does not create an artificial stop point. Other checked sections, including 130–131 and 131–132, produce paths on the selected direction. This limitation remains for vehicle highlight near that loop.

One local emulator `/vehicles` query at 2026-10-11T13:36:22.898Z returned HTTP 200, four vehicles, three with `sectionVerified=true`. The three verified vehicles matched exactly one direction each (two outbound, one return), and all three generated selected-direction sections. This is one observation, not a guarantee about later operation. A live browser map inspection of this 30 route was not completed.

Reproduce the offline diagnosis without API calls:

```powershell
node scripts/diagnose-route-directions.cjs scripts/fixtures/goyang-30-sanitized.json
node scripts/diagnose-route-directions.cjs scripts/fixtures/goyang-30-sanitized.json 30 31 32 130 131 132
node --test scripts/route-directions.test.cjs
```

The `legacyOutboundFailure` and `legacyInboundFailure` fields deliberately replay the removed nearest-only rule; `splitSucceeded` reports the current implementation. The local SVGs [법원읍 반복 구간](lawoneup-loop.svg) and [구파발 복귀 구간](gupabal-return.svg) label normalized shape indices and official stop visit sequences. They are geometry diagrams without a basemap, so road-side service at the still ambiguous stop cannot be established from them alone.
