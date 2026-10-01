# Test the full charity scene in OBS

Open [the broadcaster controls](https://nurra.org/quran-reader/control) in
Chrome or Edge on the same computer as OBS. Keep that tab open during recitation;
OBS receives the display but never opens a microphone.

1. Scroll to **Charity stream**. Enter the real partner, project and HTTPS donation
   link before a public broadcast; leave the clock stopped until you are ready.
   Save the settings. Keep **Camera window in the arch** checked if using a camera.
2. Click **Copy OBS stream link**. In a separate OBS test scene, add a **Browser**
   source, paste that exact link and set **Width 1920**, **Height 1080**. Leave
   **Shutdown source when not visible** unchecked. Fit the source to the canvas.
   The plain `/stream` URL alone is insufficient: the copied link identifies your
   stream. Use the same control browser/profile again to retain its saved link.
3. Add your camera or VTuber source below the Browser source in the Sources list.
   Position the face in the arch at the left. Its window occupies approximately
   x=134–410, y=172–520 on the 1920 × 1080 scene. The white area in an ordinary
   browser preview is transparent in OBS.
4. On the control page, enter `112:1` and press Enter. Verify Arabic, English and
   the reference in OBS before starting the microphone. Try `2:282` to check long
   ayahs; restore your intended starting ayah afterward.
5. Make a short local recording in OBS. Click **Start listening**, complete the
   voice consent yourself, then recite. Check word highlighting, a repeated phrase,
   an ayah transition, a pause longer than eight seconds and resumed recitation.
   Switch away from the test scene and back; the control page should keep listening.
6. Under **A donation came in**, announce a small amount with the donor name
   `TEST — remove before going live`. Verify the alert and total, then remove it.
   This is a manual display entry, not a payment or automatic charity integration.
   If testing the QR, scan it from the OBS recording on a phone and verify the
   destination without making a donation.
7. Stop listening and the OBS recording. Watch the recording with sound: check
   readability, camera framing, first-word capture, transitions and recovery.
   Remove every test donation and confirm the intended total before going live.

If the scene says its link is missing or was replaced, recopy it from **Charity
stream**. If it stays on the idle star, use a direct reference in the control page
first. A verse visible there but absent in OBS points to the Browser source link or
connection; a manual verse visible in both separates that problem from microphone
recognition. OBS does not need the private owner/control link or provider keys.

Local browser tests, public WebSocket checks, provider recognition, the owner's
microphone and the rendered OBS recording are separate evidence. A browser pass
does not prove the microphone or OBS recording worked.
