# Asset viewer

Use thumbnails to scan assets, open an asset for review, and ask for an iteration on one element. Opening the viewer, choosing an element, and selecting a region or time range do not approve work or spend.

## Thumbnails and display modes

Thumbnails appear in the asset list, timeline, and review drawer. Video and image assets use posters where available. Timeline video clips can use a filmstrip, timeline audio uses a waveform, and text or unavailable media uses a labelled placeholder.

The timeline supports these display modes:

| Mode | What appears |
|---|---|
| Filmstrip | Frames sampled across each video clip. The number of frames follows the clip's width and height. Still images continue to use one poster. |
| Head | One poster at the head of each clip. |
| Off | No thumbnail images. Clip names, status, and controls remain available. |

The default automatic Filmstrip/Head behavior shows a filmstrip when at least three tiles fit and falls back to a head thumbnail on narrower clips. Changing the display mode changes only the preview, never the media or timeline edit.

Poster and filmstrip generation is pre-warmed after a take lands. Thumbnails are made by a cheap local CPU ffmpeg step from an existing file; this never starts a paid GPU or Google Colab job.

## Open the viewer

- **Asset list:** select the asset's thumbnail button. Previous and Next move through the filtered list that opened the viewer.
- **Timeline:** focus a clip and press Enter, or double-click the clip.
- **Review drawer:** select **Open in viewer** on a take.

The viewer supports images, video, audio, and text. Video includes a poster, a time scrubber, and filmstrip hover previews when available. Audio includes a waveform when available. The viewer announces "Asset n of m" as you navigate, and closing it returns focus to the control that opened it.

## Keyboard map

Viewer shortcuts apply only while the dialog is open. They do not invoke the editor's timeline shortcuts. While you type in an input or note, ordinary typing keys are left to that field.

| Key | Action |
|---|---|
| Left Arrow / Right Arrow | Previous / next asset in the opening list. Navigation stops at either end. |
| Space or K | Play / pause video or audio. |
| J / L | Seek backward / forward five seconds. |
| Comma (`,`) / Period (`.`) | Step one video frame backward / forward. |
| I / O | Mark the range start / end at the current time for video or audio. |
| R | Toggle region mode for an image or video. |
| E | Open **Iterate on an element**. |
| C | Open take comparison when package, shot, and clip information is available. |
| `+` / `-` | Zoom an image in / out. |
| Escape | Close the viewer. |

Visible Previous, Next, Close, playback, zoom, Region, Iterate, and Compare controls provide the same actions where applicable.

## Regions and time ranges

Choose annotations before opening the iteration panel:

1. For an image or video, press **R** or select **Region**. Drag a box on the media, or use the keyboard alternative.
2. In region mode, Arrow keys move the box and Shift+Arrow keys resize it. The viewer reads out its position and size. Press **R** again to leave region mode; the selection remains available to the request.
3. For video or audio, move to the desired time and press **I** for the start and **O** for the end. Use the scrubber, J/L, or video frame stepping to adjust the current time. A valid range ends after it starts.

Region coordinates are normalized to the displayed media from 0 to 1, independently of its size and letterboxing. In this version, a region is prompt guidance for the agent, not a pixel-accurate inpainting mask. Omit a region or range when the request applies to the whole target.

## Iterate on an element

1. Open the asset and select **Iterate** or press **E**.
2. Choose one element: a specific **Character** or **Voice line** when listed, or **Background**, **Motion**, **Framing**, **Lighting**, **Audio**, or **Other**.
3. Review **Preserve**. Everything except the element being changed is selected by default; changing a voice line corresponds to changing Voice. Adjust the other checkboxes as needed.
4. In **What should change?**, enter a note of 1 to 500 characters. Any selected region and time range are included with the request.
5. Select **Ask the agent for a plan**.

For a production-bound project, this sends one scoped request to the agent. The agent proposes one plan limited to the selected target and element and states what it will preserve. It must not touch other shots. Review that proposal and approve it yourself before any paid work starts.

The existing safeguards still apply:

- a paid plan needs an iteration level before approval;
- the proposal must stay within that level's take, round, and audition limits;
- the ledger enforces the Google Colab spend cap; and
- choosing an element or an iteration level is not spend approval.

If the current level allows no further take, the agent asks whether you want to change the level and proposes nothing. The agent cannot approve its own plan or raise the level. After an approved plan completes, the result lands as a new take beside the original rather than overwriting it; use **Compare** to review the takes.

For an unbound or legacy project, **Ask the agent for a plan** only pre-fills the composer with your note and the scope hint. Nothing is sent automatically. Review and send it yourself, then use the existing correction-confirmation flow.

The viewer never directly calls regenerate, select, approve, or reserve. Those decisions and actions remain outside the viewer.

## Placeholders and retry

Every thumbnail state has a distinct shape and text; status is not conveyed by colour alone.

| State | What you see and what to do |
|---|---|
| Pending | **Rendering…** means the thumbnail is being prepared. The indicator is static when reduced motion is requested. |
| Failed | **Thumbnail unavailable**, a reason, and **Retry**. Retry requests the thumbnail again; it does not regenerate the asset. |
| Missing ffmpeg | A failed placeholder explains that ffmpeg is unavailable on this computer. Asset ingest and the rest of the production do not fail. |
| Text or no media | A labelled **No thumbnail**, **No poster**, **No filmstrip**, or **No waveform** placeholder, with a reason when available. |
| Audio | A waveform when available, otherwise the corresponding waveform placeholder. |

A missing or failed thumbnail does not prevent you from opening the asset viewer or preparing an iteration request.
