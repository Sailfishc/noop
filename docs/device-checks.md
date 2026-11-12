# What only a real device can check

Headless tests (`nsh test`) and the web screenshots (`scripts/screens.sh`) cover layout, text and logic. These depend
on the device itself: its camera, gestures, haptics, safe areas and native views. Check them on an iPhone (and an
Android phone where we ship one) before a release that touches them, and tick them off in the PR.

## Phone sign-in

- [ ] 扫码登录 opens the back camera in the sheet and signs in from the QR in Settings › Account on another device.
- [ ] Camera access refused: the scanner says so, 拍照识别 takes a photo through the system camera and reads it, and
      手动输入登录码 under it opens the code page with the server filled in.
- [ ] No camera (or the scanner page doesn't come up within 3 s): it falls back to the code page with the reason.
- [ ] The code, invite and ask pages: the title bar sits under the status bar (notch and Dynamic Island), back returns
      to 扫码登录, the keyboard doesn't cover the field being typed in.

## Moving around

- [ ] A swipe from the left edge goes back: thread → channel → the list, following the finger, and a cancelled swipe
      stays. Android: predictive back does the same, and back at the list leaves the app.
- [ ] 待你决定 and 任务 switch as tabs (no push animation); opening a task's thread from them pushes it, and back
      returns to the list.
- [ ] The app opens on 待你决定 when something waits there, and on 消息 otherwise.
- [ ] The tab bar clears the home indicator; it hides while the keyboard is up and inside a channel or thread.

## Sheets and menus

- [ ] A Modal (new reminder, confirm steps) and an ⓘ note rise from the bottom; a swipe down, the backdrop and back
      close them; the sheet clears the home indicator and never goes under the status bar when tall.
- [ ] A held finger on a 待你决定 row, a channel or an agent opens its menu as a sheet; the first item can be pressed
      without a second, accidental press.
- [ ] A Choice too wide for the screen shows as a list, each option a full-width row.

## Haptics

- [ ] One success tap when accepting a result (验收通过 / 标为完成) and when deciding (an option on 等你决定, 按这个做
      on an alignment), and none on any other button.
- [ ] Nothing on the Mac, the web or a phone with system haptics off.

## Not built: swipe a row to remind later

NSH 0.5 has no native swipeable row. A JS responder on each row would fight the list's vertical scroll and draw a
moving row from JS every frame (outside the six motion moments). Remind later stays in the row's long-press menu
on phones and on H on desktops.
