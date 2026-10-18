/**
 * Instructions shipped with every captured workflow (W1).
 *
 * UI-format conversion is not done here. ComfyUI drag-and-drop needs widget
 * order from the running install, and the submitted graph does not carry it.
 */
export const OPEN_IN_COMFYUI_MARKDOWN = `# Open in ComfyUI

These files are the API-format workflows Comfyrizz submitted for each generated still and plate.
Each one contains the seed, prompt, model filenames and parameters that were sent.
Secret-shaped strings (tokens, API keys, signed URLs) are removed before the file is written.
No Hugging Face token and no Google Colab token is stored here.

## Drag-and-drop

ComfyUI's canvas Load button and drag-and-drop expect the UI workflow format
(\`nodes\`, \`links\`, and each node's \`widgets_values\` in that node's widget order).
The submitted graph is API format. API format does not record widget order or socket types;
those come from the running ComfyUI install (\`/object_info\`).
A conversion that guesses the order opens as a broken graph, so Comfyrizz does not write a UI-format workflow.
The \`.workflow.api.json\` file next to each asset is the graph that was submitted.

## Replay a graph

On a ComfyUI that has the same models:

\`\`\`bash
curl -sS http://127.0.0.1:8188/prompt \\
  -H 'content-type: application/json' \\
  --data-binary @- <<EOF
{"prompt": <contents of the .workflow.api.json file>}
EOF
\`\`\`

The same JSON is the \`workflow\` body of a Comfy API v2 job (\`POST /api/v2/jobs\`),
which is the call Comfyrizz makes.
`;
