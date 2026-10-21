# Credits

**What is credited.** Every asset declared by the example packages
(`examples/*/package.json`, the Comfyrizz package format): title, creator,
licence id, approval, redistributable status, whether the asset would ship, and
its source — as reported by `scripts/credits-audit.mjs`. The audit covers
generated assets, user uploads and stock/CC sources used across the twelve
example packages.

Model weights, Remotion terms, fonts and key npm/python dependencies are
credited separately in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). Which
licences may enter the project or ship in `package.zip` is decided by the
licence policy (v0.1) in
[packages/sources/README.md](packages/sources/README.md), which defines
`evaluateLicense()` and `isAssetRedistributable()` as the single gate used by
credits and the zip builder.

## Regenerate

Everything below the rule is the verbatim output of:

```sh
node scripts/credits-audit.mjs --md
```

Re-run that command and replace the audit section below with its output to
refresh this file. `node scripts/credits-audit.mjs --check` exits 1 when the
audit finds problems (`--json` prints the same report as JSON).

## Open issues

None reported: the current audit run prints
`12 package(s) · 69 asset(s) · 53 would ship · 0 problem(s)` and
`No problems found.`, and `--check` exits 0. The full output, including any
problems the audit would list, is reproduced verbatim below; do not edit it by
hand.

---

# Credits audit

12 package(s) · 69 asset(s) · 53 would ship · 0 problem(s)

No problems found.

## Assets

| Package | Asset | Title | Creator | Licence | Approval | Redistributable | Ships | Source | Problems |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| examples/brand-kit | a_anim_bars | a_anim_bars | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/brand-kit | a_brandlogo0001 | a_brandlogo0001 | Unknown creator | User-Upload | approved | yes | yes | upload | — |
| examples/brand-kit | a_diagram_flow | a_diagram_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/brand-kit | a_icon_check | a_icon_check | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/brand-kit | a_pattern_dots | a_pattern_dots | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/cast-mascot | a_intro | a_intro | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/cast-mascot | a_next | a_next | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/cast-mascot | a_pip | a_pip | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/data-story | a_anim_rise | a_anim_rise | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/data-story | a_data_frame | a_data_frame | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/data-story | a_data_plate | a_data_plate | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/data-story | a_data_still | a_data_still | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/data-story | a_kpi_cards | a_kpi_cards | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/data-story | a_trend_line | a_trend_line | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/hook-20s | a_anim_bars | a_anim_bars | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/hook-20s | a_diagram_flow | a_diagram_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/hook-20s | a_icon_check | a_icon_check | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/hook-20s | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/launch-demo | a_anim_bars | a_anim_bars | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/launch-demo | a_diagram_flow | a_diagram_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/launch-demo | a_icon_check | a_icon_check | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/launch-demo | a_pattern_dots | a_pattern_dots | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/licensing-demo | openverse-approved | Morning Fog over the Harbour | Marta Rivera | [CC-BY-4.0](https://creativecommons.org/licenses/by/4.0/) | approved | yes | yes | [openverse:ov-7f3a9c21](https://openverse.org/image/8f3a7c91-2d4e-4b6a-9f10-5c2d7e8a1b34) | — |
| examples/licensing-demo | openverse-refused | City Lights at Midnight | Leo Fischer | [CC-BY-NC-4.0](https://creativecommons.org/licenses/by-nc/4.0/) | not approved | no | no | [openverse:ov-1c9e5b72](https://openverse.org/image/1c9e5b72-6a3f-4d81-b0e2-7f4a9c6d2e58) | — |
| examples/narrated-demo | a_anim_bars | a_anim_bars | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/narrated-demo | a_diagram_flow | a_diagram_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/narrated-demo | a_icon_check | a_icon_check | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/narrated-demo | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/narrated-demo | a_pattern_dots | a_pattern_dots | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/presenter-demo | a_presenter_face | a_presenter_face | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_anim_orbit | a_anim_orbit | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_feature_cards | a_feature_cards | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_flow_pipeline | a_flow_pipeline | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_hero_still | a_hero_still | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/product-explainer | a_logo_mark | a_logo_mark | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/product-explainer | a_plate_loop | a_plate_loop | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | no | generated | — |
| examples/showcase-gpu2 | a_battery | a_battery | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_iso_solar | a_iso_solar | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_mascot | a_mascot | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_particles | a_particles | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_ribbons | a_ribbons | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_solarfarm | a_solarfarm | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_sunrise | a_sunrise | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu2 | a_svg_flow | a_svg_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_chart_i2i | a_chart_i2i | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_city | a_city | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_city_still | a_city_still | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_flow | a_flow | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_flow_ref | a_flow_ref | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_mascot | a_mascot | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_mascot_still | a_mascot_still | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_svg_chart_src | a_svg_chart_src | Unknown creator | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | upload | — |
| examples/showcase-gpu3 | a_svg_flow_src | a_svg_flow_src | Unknown creator | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | upload | — |
| examples/showcase-gpu3 | a_title_plate | a_title_plate | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_turbine | a_turbine | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/showcase-gpu3 | a_turbine_still | a_turbine_still | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/willem-birthday | a_cake | a_cake | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_dj | a_dj | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_dragon | a_dragon | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_narration | a_narration | Comfyrizz (generated) | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) | not approved | yes | yes | generated | — |
| examples/willem-birthday | a_orchestra | a_orchestra | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_portrait | a_portrait | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_racecar | a_racecar | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_rocket | a_rocket | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_soccer | a_soccer | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |
| examples/willem-birthday | a_surf | a_surf | Comfyrizz (generated) | LicenseRef-private-family | not approved | no | no | generated | — |

“Ships” means the package references the asset and either its file is present or it is marked ready and not explicitly non-redistributable. Non-redistributable assets that would ship, unknown licence ids and CC BY assets without attribution are problems.

