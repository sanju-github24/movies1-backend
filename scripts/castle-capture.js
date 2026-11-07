// castle-capture.js — dump Castle's real getVideo request (method, URL, headers, body).
// Hooks OkHttp's Request.Builder.build() (class names kept by Retrofit), so it sees
// the FINAL request after the sign/auth interceptors run.
//   frida -U -f com.external.castle -l scripts/castle-capture.js
// then in the app: open a movie and press "Watch Now".
Java.perform(function () {
  function dump(req, tag) {
    try {
      var url = req.url().toString();
      if (url.indexOf('getVideo') === -1) return;
      var out = '\n================ getVideo (' + tag + ') ================\n' + req.method() + ' ' + url + '\n';
      var h = req.headers();
      for (var i = 0; i < h.size(); i++) out += h.name(i) + ': ' + h.value(i) + '\n';
      var body = req.body();
      if (body) {
        var Buffer = Java.use('okio.Buffer');
        var buf = Buffer.$new();
        body.writeTo(buf);
        out += 'BODY: ' + buf.readUtf8() + '\n';
      }
      out += '===============================================================';
      console.log(out);
    } catch (e) { console.log('dump err: ' + e); }
  }
  try {
    var Builder = Java.use('okhttp3.Request$Builder');
    Builder.build.implementation = function () {
      var req = this.build();
      dump(req, 'build');
      return req;
    };
    console.log('[+] hooked okhttp3.Request$Builder.build');
  } catch (e) { console.log('[!] okhttp3 hook failed: ' + e + ' — tell Claude'); }
  console.log('[*] ready — open a movie and press "Watch Now"');
});
