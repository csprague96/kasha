# Kasha

Meeting notes for Windows. Kasha notices when a Teams, Slack, RingCentral or Zoom call starts and offers to transcribe it. It records on your PC without joining the call, transcribes locally, writes a summary with Claude, and saves the note to Obsidian.

## Using it

1. Download `Kasha-Setup-<version>.exe` from the [latest release](https://github.com/csprague96/kasha/releases/latest) and run it. It installs for your user only (no admin rights) and opens Kasha. Setup has three items:
   - **Speech models**: a one-time download of about 400 MB. Transcription and speaker separation run on your PC, so audio never leaves it.
   - **Summaries**: written by Claude Code or Codex using your existing sign-in, so no API key is needed. Sign in once with `claude` or `codex login`. **Automatic** (the default) uses Claude Code when it's signed in, otherwise Codex; you can pick one in Settings. Without either, you still get transcripts.
   - **Obsidian vault**: optional. Notes go to `Meetings/` in the vault.
2. Join a call as usual. When **Meeting detected** appears, select **Start transcribing**.
3. A bar stays at the top of the screen during the call:
   - **Note** adds a timestamped line to the note.
   - **Screenshot** opens the Windows snipping overlay; the image is added to the note.
   - **Stop** ends the recording. Kasha also stops on its own about 20 seconds after the call app releases the mic.
4. Kasha transcribes during the call, a minute or so behind, so the **Transcript** tab fills in as you talk. When the call ends it finishes the last few seconds and summarizes in the background. The note gets Summary, Decisions and Actions sections above your own notes, and then syncs to Obsidian.

Kasha updates itself: it checks the releases a few times a day, downloads a new version in the background, and the sidebar shows **Restart to update** when it's ready (it also installs on the next quit, but never while a call is being recorded or processed). The version is at the bottom of the sidebar; **Check for updates** is in Settings > General.

### Recording rules

Settings > Recording decides what happens when a call starts: **Ask each time** (a prompt in the corner), **Record every call**, or **Only the meetings and people under Always record**. The **Always record** lists are matched on the meeting title and, with the Outlook lookup on, the invite list; recording a recurring meeting offers to add it. The **Never record** list applies in every mode: those meetings are neither recorded nor asked about, and the call prompt has a **Never record this meeting** link that adds to it.

### Speech models

Settings > Transcription offers three models, all running on this PC: **Quick** (Parakeet 4-bit, the default), **Careful** (Parakeet 8-bit, a little more accurate, about 850 MB while running) and **Thorough** (Whisper medium.en: the most accurate on hard audio and jargon, the only one that takes Names and terms as spelling hints, several times slower, about 1 GB while running). Choosing a model downloads it; Kasha keeps using the one it has until the download finishes.

### Actions

**Actions** in the sidebar lists open checkboxes from every note, grouped by meeting. Your own come first and everyone else's are listed under **Others**, so you can follow up on them. Ticking an item updates the note and the Obsidian copy; the **×** on an item removes a checkbox that wasn't really an action, from the note and the Obsidian copy. Items ticked in Obsidian show as done in Kasha. Set **Your name** in Settings so actions assigned to you by name count as yours. On weekdays at 09:00 (configurable), a notification lists how many of your actions are open, due today or overdue.

Due dates are stored in the note as `(due 2026-10-06)`. Shared copies show them as "due Tue 6 Oct".

### Transcript

- **Speakers**: after the call, the people on the computer's audio are told apart as **Speaker 1**, **Speaker 2** and so on (your mic is always **You**). Select a name at the top of the transcript to rename it everywhere. Select the name on a line to move that line to someone else, or to **Someone else** for a new speaker. The summary uses the names after you select **Update summary**.
- **Recognising people**: when you name a speaker, Kasha keeps that voice (a short list of numbers, not audio) in `voices.json` on your PC. Next time the same person is on a call, the name is filled in. Settings lists the learned voices and lets you forget one; turn **Recognise people from past meetings** off to stop learning. With the attendee lookup on, the invite list from Outlook is offered when you rename a speaker.
- **Edit**: select a line to fix it. Enter saves and Esc cancels. When the edit changes one word, Kasha offers to remember the fix for future meetings.
- **Correct a word**: right-click a word in the transcript or the note, type how it should be spelled, and it's replaced throughout both. **Fix in future meetings too** (on by default) adds the pair to **Names and terms**.
- **Find and replace** (Ctrl+H): replaces whole words in the transcript and, optionally, the note. **Fix in future meetings too** adds the correction to **Names and terms**.

### Attendees

The **Attendees** tab lists who was at the meeting: the invite list (from Outlook when the attendee lookup is on, or people you add) against who was heard on the recording. Someone on the list who matches a named speaker shows as **Spoke** with their talking time; someone who doesn't is **Not heard**. People heard but not on the list are listed too, including unnamed speakers until you name them in the Transcript tab. A recording can't tell a silent attendee from a no-show, so hover a row to mark a person present or absent by hand, or to remove them from the list. The names go into the Obsidian note's front matter as `attendees` and `not_heard`, and onto the first line of shared copies.

### Names and terms

In Settings, list people's names and product terms, with what the speech model tends to hear instead (for example **RCVR**, heard as "Recover"). Kasha replaces the misheard forms in every new transcript (and, with a Whisper model, also gives the list to it as spelling hints). Replacement is whole-word and ignores case, so "recover" the verb is changed too. Leave the "heard as" part out for words that are only ever the name. The list is alphabetical, with a filter box and letter headings once it grows.

### Tags and finding notes

Each note has tags (the summary suggests one to three; add your own under the note, with existing tags offered as you type). Settings > Tags lists every tag in use: rename one to change it on every note, or remove it everywhere. Standing tags (say, `meeting`) go into every note Kasha writes to Obsidian, and the summary's topic tags can be turned off. In the sidebar, the calendar next to the search box marks the days that have notes; pick one to see just that day.

### Share

**Share** on a note offers Copy, Email, Save as PDF and Save as Markdown, with a choice of summary and notes, transcript, or both. Summary only is the default. **Email** copies the formatted note and opens a new email with the subject filled in; paste the body with Ctrl+V. New Outlook can't open pre-filled drafts from a file, which is why the body is pasted.

You can also type notes in the main window during the call, paste or drop images into a note, or start a recording without a call from **New note**, then **Record**.

Tell people on the call when you're transcribing.

## How it works

| Part | Approach |
|---|---|
| Meeting detection | Polls the Windows mic-usage registry (`CapabilityAccessManager\ConsentStore\microphone`) every 3 s. Names the meeting from the call app's window title. |
| Audio | Mic and system audio (WASAPI loopback) are recorded as separate 16 kHz WAV tracks. In the transcript, the mic track is labelled **You** and the system audio **Others**, until you name them. |
| Transcription | NVIDIA **Parakeet TDT 0.6B v3** (4-bit), run by `parakeet-cli` from [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Silero voice activity detection finds the speech in each track, which is packed into ~28-second chunks with short silences between the pieces. Parakeet's own word timings map every word back to when it was said, so lines from both tracks interleave in the right order. During a call a chunk is transcribed once about 20 seconds of speech has built up, on 4 threads at below-normal priority. One process runs at a time; a 28 s chunk takes about 4.6 s on a Core Ultra 7, peaks around 540 MB and exits (Whisper `small.en` took 18 s and 580 MB for the same chunk). With **Transcribe during the call** off, and on Retry, the same chunks run after the call on up to 6 threads. PCs that only have the older Whisper model keep using it until the new download runs. |
| Speakers | After the call, the system-audio track is split by voice with [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx): pyannote segmentation 3.0 plus 3D-Speaker CAM++ embeddings, run in a separate process (`speakers-worker.js`) that exits when done (about 350 MB while running, roughly 0.15x real time of the speech on 4 threads). Only the stretches with speech are analysed. Clusters closer than 0.7 cosine are merged and tiny ones folded in. Each speaker's embedding is saved in `speakers.json` beside the transcript; naming a speaker files that embedding under the name in `voices.json`, and later meetings name a voice that matches at 0.7 or above. |
| Summary | `claude -p` with no tools, no MCP and no project settings, or `codex exec` read-only with its shell tool and MCP servers off. Both use structured JSON output, and only transcript text is sent. If Claude Code isn't signed in, Automatic falls back to Codex. |
| Obsidian | Writes `{date} {title}.md` with YAML front matter; screenshots go to `attachments/`. A note that was edited in Obsidian since the last sync is not overwritten. |
| Storage | `%APPDATA%\Kasha\meetings\<id>\`: `meta.json`, `note.md`, `transcript.json`, `attachments/`. By default, audio is deleted after transcription; with **Keep audio** on it stays for 7 days, then goes. |
| Updates | [electron-updater](https://www.electron.build/auto-update) against this repo's GitHub releases. The Release workflow builds the installer on every push to `main` and publishes `v<version>` when `package.json` has a version with no release yet. |

### Compliance

- Card numbers (Luhn-checked, 13–19 digits) and SSNs are replaced with `[card number]` / `[SSN]` before the transcript is saved or sent to Claude.
- The summary prompt tells the model never to include card numbers, account numbers, SSNs or passwords.
- Codex use was approved by compliance. Use a company ChatGPT account for it, not a personal one.
- Audio stays on the device and is deleted once transcribed. With **Keep audio for 7 days** on, it stays on the PC for a week (each note shows when it goes, with **Save a copy** and **Delete now**) and is then deleted automatically.
- Learned voices are embeddings (512 numbers per meeting per person), not recordings, and never leave `%APPDATA%Kashaoices.json`. They are biometric-like data: tell people on the call when you're transcribing, and turn **Recognise people from past meetings** off if your policy requires it.
- The speech binaries are pinned by SHA-256, and every model is verified against the hash its publisher lists.

### Memory use

- The GPU process is disabled, since the UI renders fine on the CPU.
- Closing the window destroys it; Kasha keeps running in the tray.
- The prompt and the recording bar are created only when needed and destroyed afterwards.
- Speech runs one chunk at a time at below-normal priority and exits after each, so no model stays loaded during the call. Speaker separation runs once per call in its own process and exits.

## Development

```bash
npm install
npm run dev        # hot reload
npm run build      # production build to out/
npm run dist       # Windows installer to dist/
npm run icons      # regenerate icons from the logo
```

To ship an update, bump `version` in `package.json` and merge to `main`: the Release workflow builds and publishes it, and installed copies pick it up. `KASHA_FAKE_UPDATE="ready 0.3.0"` shows the update UI from source.

`KASHA_NO_DETECT=1` turns off meeting detection, which is useful while testing during a real call. `KASHA_DATA_DIR=<folder>` keeps settings and notes in a separate folder so tests never touch real notes. `KASHA_TEST_SAVE_DIR=<folder>` saves PDF and Markdown exports there without a dialog.

Layout: `src/main` (Electron main process), `src/preload`, `src/renderer` (React + Tailwind; three pages: `index`, `toast`, `bar`), `src/shared` (types and the IPC contract).
