// The QR scanner's web page (qr-scanner.tsx), apart from nsh so a browser test can load it as it is.
import { JSQR } from "./jsqr";

/** The scanner's page: everything inline (the origin serves nothing), its words in `text`. */
export function scannerPage(text: Record<string, string>) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<style>
html,body{margin:0;height:100%;overflow:hidden;background:#000;color:#fff;font:15px/1.4 -apple-system,system-ui,sans-serif;-webkit-user-select:none;user-select:none}
video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
#frame{position:absolute;left:50%;top:46%;width:60vmin;height:60vmin;transform:translate(-50%,-50%);border:2px solid rgba(255,255,255,.9);border-radius:12px;box-shadow:0 0 0 100vmax rgba(0,0,0,.35)}
#msg{position:absolute;left:16px;right:16px;bottom:16px;text-align:center;text-shadow:0 1px 2px #000}
#photo{display:none;position:absolute;left:50%;top:46%;transform:translate(-50%,-50%);padding:10px 18px;border-radius:8px;background:#fff;color:#000;font-weight:600}
#photo input{display:none}
body.still #frame{display:none}
body.still #photo{display:block}
</style></head><body>
<video id="video" playsinline muted autoplay></video><div id="frame"></div>
<label id="photo">${esc(text.photo)}<input id="file" type="file" accept="image/*" capture="environment"></label>
<div id="msg">${esc(text.starting)}</div>
<script>${JSQR}</script>
<script>
(function () {
  var T = ${JSON.stringify(text)};
  var video = document.getElementById("video"), msg = document.getElementById("msg"), file = document.getElementById("file");
  var canvas = document.createElement("canvas"), cx = canvas.getContext("2d", { willReadFrequently: true });
  var last = "", lastAt = 0;
  function post(o) { if (window.nsh && window.nsh.postMessage) window.nsh.postMessage(JSON.stringify(o)); }
  post({ type: "ready", secure: !!window.isSecureContext, media: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) });
  function found(t) {
    var now = Date.now();
    if (t === last && now - lastAt < 2000) return;
    last = t; lastAt = now;
    post({ type: "code", text: t });
  }
  // the image's pixels at most 720 on a side, read by jsQR
  function read(img, w, h) {
    var k = Math.min(1, 720 / Math.max(w, h));
    canvas.width = Math.round(w * k); canvas.height = Math.round(h * k);
    cx.drawImage(img, 0, 0, canvas.width, canvas.height);
    var d = cx.getImageData(0, 0, canvas.width, canvas.height);
    var r = self.jsQR(d.data, d.width, d.height, { inversionAttempts: "attemptBoth" });
    return r && r.data ? r.data : null;
  }
  function still(why, code) { document.body.className = "still"; msg.textContent = why + (code ? " (" + code + ")" : ""); if (code) post({ type: "error", code: code }); }
  file.addEventListener("change", function () {
    var f = file.files && file.files[0];
    if (!f) return;
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      var t = read(img, img.naturalWidth, img.naturalHeight);
      URL.revokeObjectURL(url); file.value = "";
      if (t) found(t); else msg.textContent = T.missed;
    };
    img.src = url;
  });
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return still(T.none, window.isSecureContext ? "NoMediaDevices" : "InsecureContext");
  navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }).then(function (stream) {
    video.srcObject = stream;
    var p = video.play(); if (p && p.catch) p.catch(function (e) { post({ type: "error", code: "Play" + ((e && e.name) || "") }); });
    msg.textContent = T.aim;
    // a stream that never shows a frame (an iPhone web view that won't play video inline): offer the photo instead
    setTimeout(function () { if (video.readyState < 2 || !video.videoWidth) still(T.stalled, "NoFrames"); }, 4000);
    window.addEventListener("pagehide", function () { stream.getTracks().forEach(function (t) { t.stop(); }); });
    var at = 0;
    (function tick(now) {
      requestAnimationFrame(tick);
      if (now - at < 150 || video.readyState < 2 || !video.videoWidth) return;
      at = now;
      var t = read(video, video.videoWidth, video.videoHeight);
      if (t) found(t);
    })(0);
  }, function (e) {
    still(e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? T.denied : T.none, (e && e.name) || "GetUserMediaFailed");
  });
})();
</script></body></html>`;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
