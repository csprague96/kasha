# Kasha

Meeting notes for Windows. Kasha notices when a Teams, Slack, RingCentral or Zoom call starts and offers to transcribe it. It records on your PC without joining the call, transcribes locally, writes a summary with Claude, and saves the note to Obsidian.

## Using it

1. Install and open Kasha. Setup has three items:
   - **Speech model**: a one-time 200 MB download. Transcription runs on your PC, so audio never leaves it.
   - **Claude Code**: writes the summary using your existing Claude sign-in. Install Claude Code and run `claude` once to sign in. No API key is needed. Without it, you still get transcripts.
   - **Obsidian vault**: optional. Notes go to `Meetings/` in the vault.
2. Join a call as usual. When **Meeting detected** appears, select **Start transcribing**.
3. A bar stays at the top of the screen during the call:
   - **Note** adds a timestamped line to the note.
   - **Screenshot** opens the Windows snipping overlay; the image is added to the note.
   - **Stop** ends the recording. Kasha also stops on its own about 20 seconds after the call app releases the mic.
4. After the call, Kasha transcribes and summarizes in the background. The note gets Summary, Decisions and Actions sections above your own notes, and then syncs to Obsidian.

### Actions

**Actions** in the sidebar lists open checkboxes from every note, grouped by meeting. Your own come first and everyone else's are listed under **Others**, so you can follow up on them. Ticking an item updates the note and the Obsidian copy. Items ticked in Obsidian show as done in Kasha. Set **Your name** in Settings so actions assigned to you by name count as yours. On weekdays at 09:00 (configurable), a notification lists how many of your actions are open, due today or overdue.

Due dates are stored in the note as `(due 2026-10-06)`. Shared copies show them as "due Tue 6 Oct".

### Share

**Share** on a note offers Copy, Email, Save as PDF and Save as Markdown, with a choice of summary and notes, transcript, or both. Summary only is the default. **Email** copies the formatted note and opens a new email with the subject filled in; paste the body with Ctrl+V. New Outlook can't open pre-filled drafts from a file, which is why the body is pasted.

You can also type notes in the main window during the call, paste or drop images into a note, or start a recording without a call from **New note**, then **Record**.

Tell people on the call when you're transcribing.

## How it works

| Part | Approach |
|---|---|
| Meeting detection | Polls the Windows mic-usage registry (`CapabilityAccessManager\ConsentStore\microphone`) every 3 s. Names the meeting from the call app's window title. |
| Audio | Mic and system audio (WASAPI loopback) are recorded as separate 16 kHz WAV tracks. In the transcript, the mic track is labelled **You** and the system audio **Others**. |
| Transcription | [whisper.cpp](https://github.com/ggml-org/whisper.cpp) `small.en` (5-bit quantized) with Silero voice activity detection, so silence is skipped. It runs as a low-priority process after the call ends, then exits. Peak RAM is about 620 MB. |
| Summary | `claude -p` with no tools, no MCP and no project settings, using structured JSON output. Only transcript text is sent. |
| Obsidian | Writes `{date} {title}.md` with YAML front matter; screenshots go to `attachments/`. A note that was edited in Obsidian since the last sync is not overwritten. |
| Storage | `%APPDATA%\Kasha\meetings\<id>\`: `meta.json`, `note.md`, `transcript.json`, `attachments/`. By default, audio is deleted after transcription. |

### Compliance

- Card numbers (Luhn-checked, 13–19 digits) and SSNs are replaced with `[card number]` / `[SSN]` before the transcript is saved or sent to Claude.
- The summary prompt tells Claude never to include card numbers, account numbers, SSNs or passwords.
- Audio stays on the device and is deleted once transcribed, unless **Keep audio after transcribing** is on.
- The Whisper binary is pinned by SHA-256, and the model is verified against the hash Hugging Face publishes.

### Memory use

- The GPU process is disabled, since the UI renders fine on the CPU.
- Closing the window destroys it; Kasha keeps running in the tray.
- The prompt and the recording bar are created only when needed and destroyed afterwards.
- Whisper runs once per meeting, after the call, at below-normal priority, and exits.

## Development

```bash
npm install
npm run dev        # hot reload
npm run build      # production build to out/
npm run dist       # Windows installer to dist/
npm run icons      # regenerate icons from the logo
```

`KASHA_NO_DETECT=1` turns off meeting detection, which is useful while testing during a real call. `KASHA_DATA_DIR=<folder>` keeps settings and notes in a separate folder so tests never touch real notes. `KASHA_TEST_SAVE_DIR=<folder>` saves PDF and Markdown exports there without a dialog.

Layout: `src/main` (Electron main process), `src/preload`, `src/renderer` (React + Tailwind; three pages: `index`, `toast`, `bar`), `src/shared` (types and the IPC contract).
