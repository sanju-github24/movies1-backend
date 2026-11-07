// aml-hook.js — crack allmovieland/Vedu: dump the real native host/keys, the
// Decrypted() cipher in/out, the play URLs, and the final m3u8.
//   frida -U -f nati.toallasrud.vedu -l aml-hook.js
// then in the app: open a movie and press play.
Java.perform(function () {
  function b64(s){ try { return Java.use('java.lang.String').$new(Java.use('android.util.Base64').decode(s,0)); } catch(e){ return '(b64 fail)'; } }

  // 1) The native constants (real values at runtime, not the static decoys)
  try {
    var E = Java.use('nati.toallasrud.vedu.Models.EncryptedLib');
    ['baseUrlFromJNI','moveNameUrl','ThreeKey','FourKey','FiveKey'].forEach(function (m) {
      E[m].implementation = function () {
        var r = this[m]();
        console.log('[NATIVE] ' + m + '() = ' + r + '   (b64-> ' + b64(r) + ')');
        return r;
      };
    });
    // 2) The response cipher — every decrypt, input -> output (videoUrl -> m3u8)
    E.Decrypted.implementation = function (s) {
      var r = this.Decrypted(s);
      if (r && (r.indexOf('http') !== -1 || r.indexOf('.m3u8') !== -1 || r.length > 40))
        console.log('\n[DECRYPTED]\n  in : ' + (s ? s.substring(0, 80) : s) + '\n  out: ' + r + '\n');
      return r;
    };
    console.log('[+] hooked EncryptedLib');
  } catch (e) { console.log('[!] EncryptedLib hook failed: ' + e); }

  // 3) The final stream URL handed to the player
  try {
    var Y = Java.use('nati.toallasrud.vedu.VideoPlayer.YoutubeActivity');
    Y.playVideo.implementation = function (u) {
      console.log('\n================ PLAY URL (m3u8) ================\n' + u + '\n=================================================');
      return this.playVideo(u);
    };
    console.log('[+] hooked YoutubeActivity.playVideo');
  } catch (e) { console.log('[!] playVideo hook failed: ' + e); }

  // 4) Every Volley request URL (shows the play/playlist endpoint on the real host)
  try {
    var Req = Java.use('com.android.volley.Request');
    Req.getUrl.implementation = function () {
      var u = this.getUrl();
      if (u && u.indexOf('vedu') !== -1) console.log('[API] ' + this.getMethod() + ' ' + u);
      return u;
    };
    console.log('[+] hooked Volley Request.getUrl');
  } catch (e) { console.log('[!] Volley hook failed: ' + e); }

  console.log('[*] ready — open a movie and press play');
});
