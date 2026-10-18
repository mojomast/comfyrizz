# CSV chart scenes (D1)

`data.csv` is the source of truth; `package.json` is generated from it by the
same pure functions the server uses (`datasetFromCsv` + `proposeChartScenes`),
so every label and value the renderer draws comes from the CSV.

```
label,value
CPU slice,6
Render queue,19
Review edits,11
Waiting,34
```

The package holds one dataset (`d_minutes`, unit `minutes`, source `user`) and
three data scenes:

| Scene | Layout | Draws |
| --- | --- | --- |
| `s_data_minutes_bar` | `chart` | one bar per CSV row, labelled with the CSV label and value |
| `s_data_minutes_number` | `stat` | the first CSV value as a big number (`6 minutes`) |
| `s_data_minutes_comparison` | `list` | every `label: value` line in CSV order |

Regenerate after editing `data.csv` (needs the built agent package):

```bash
npm --prefix packages/agent run build
node examples/tools/author-csv-package.mjs
```

`apps/renderer/test/csv-charts.test.mjs` asserts the committed package is a fresh
build of the CSV and that `chartSeries` (the exact series `ChartLayout` maps
over) returns the CSV labels and values. Line charts are not proposed: the
schema only allows `data.display` of `bar | number | counter` and the chart
variant is `bar`; a line variant is MS2 schema work.

The example uses no assets, no model and no network, so it renders on CPU.
