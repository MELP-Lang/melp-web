// MELP Compiler Worker
// Ana thread'den gelen mesajları karşılar, WASM derleme/çalıştırmayı burada yapar.
// UI thread'i bloke olmaz.
//
// Mesaj protokolü (ana thread → worker):
//   { type: 'compile', code, run }
//   { type: 'cancel' }
//
// Mesaj protokolü (worker → ana thread):
//   { type: 'worker-ready' }
//   { type: 'compile-start' }
//   { type: 'compile-success', size }
//   { type: 'compile-error', stderr }
//   { type: 'run-start' }
//   { type: 'run-stdout', stdout }
//   { type: 'run-stderr', stderr }
//   { type: 'run-exit', exitCode }
//   { type: 'run-cancel' }

'use strict';

let _melpModule = null;
let _cancelled  = false;

async function loadMelpModule() {
  if (_melpModule) return _melpModule;
  if (typeof MelpCompiler === 'undefined') {
    throw new Error('MelpCompiler tanımlı değil.');
  }
  // locateFile: .wasm dosyasının gerçek path'ini ver
  // Worker URL'i http://localhost:8080/compiler-worker.js
  // .wasm dosyası http://localhost:8080/wasm/melp_compiler.wasm
  const base = self.location.href.replace(/\/[^/]*$/, '/');
  _melpModule = await MelpCompiler({
    locateFile(filename) {
      return base + 'wasm/' + filename;
    }
  });
  return _melpModule;
}

async function execWasm(wasmBytes) {
  const importObject = {
    wasi_snapshot_preview1: {
      fd_write(fd, iovPtr, iovCnt, nwrittenPtr) {
        const mem = new DataView(instance.exports.memory.buffer);
        let written = 0;
        for (let i = 0; i < iovCnt; i++) {
          const base  = mem.getUint32(iovPtr + i * 8,     true);
          const len   = mem.getUint32(iovPtr + i * 8 + 4, true);
          const bytes = new Uint8Array(instance.exports.memory.buffer, base, len);
          const chunk = new TextDecoder().decode(bytes);
          self.postMessage({ type: 'run-stdout', stdout: chunk });
          written += len;
        }
        mem.setUint32(nwrittenPtr, written, true);
        return 0;
      },
      proc_exit(code)        { throw { exitCode: code }; },
      environ_get()          { return 0; },
      environ_sizes_get()    { return 0; },
      args_get()             { return 0; },
      args_sizes_get()       { return 0; },
      clock_time_get()       { return 0; },
      clock_res_get()        { return 0; },
    }
  };
  let instance;
  ({ instance } = await WebAssembly.instantiate(wasmBytes, importObject));
  try {
    if (instance.exports._start) {
      instance.exports._start();
    } else {
      instance.exports.main?.();
    }
  } catch (e) {
    if (e && typeof e.exitCode !== 'undefined' && e.exitCode !== 0) {
      return { stderr: `exit code ${e.exitCode}`, exitCode: e.exitCode };
    }
  }
  return { stderr: '', exitCode: 0 };
}

async function handleCompile(code, run) {
  _cancelled = false;

  self.postMessage({ type: 'compile-start' });

  let mod;
  try {
    mod = await loadMelpModule();
  } catch (err) {
    self.postMessage({ type: 'compile-error', stderr: err.message });
    return;
  }

  if (_cancelled) { self.postMessage({ type: 'run-cancel' }); return; }

  const rc = mod.ccall('melp_compile', 'number', ['string'], [code]);
  if (rc !== 0) {
    const errStr = mod.ccall('melp_get_error', 'string', [], []);
    self.postMessage({ type: 'compile-error', stderr: errStr || 'Derleme hatası' });
    return;
  }

  const size     = mod.ccall('melp_get_wasm_size', 'number', [], []);
  const ptr      = mod.ccall('melp_get_wasm_ptr',  'number', [], []);
  const wasmBytes = new Uint8Array(mod.HEAPU8.buffer, ptr, size).slice();

  self.postMessage({ type: 'compile-success', size });

  if (!run) return;

  if (_cancelled) { self.postMessage({ type: 'run-cancel' }); return; }

  self.postMessage({ type: 'run-start' });

  let result;
  try {
    result = await execWasm(wasmBytes);
  } catch (err) {
    self.postMessage({ type: 'run-stderr', stderr: err.message });
    self.postMessage({ type: 'run-exit',   exitCode: 1 });
    return;
  }

  if (_cancelled) { self.postMessage({ type: 'run-cancel' }); return; }

  if (result.stderr) self.postMessage({ type: 'run-stderr', stderr: result.stderr });
  self.postMessage({ type: 'run-exit', exitCode: result.exitCode });
}

// melp_compiler.js'i Worker scope'una yükle
try {
  importScripts('./wasm/melp_compiler.js');
} catch (e) {
  // path hatası olursa loadMelpModule() içinde yakalanır
}

// Modülü önceden yükle, hazır olunca bildir
loadMelpModule()
  .then(() => self.postMessage({ type: 'worker-ready' }))
  .catch(() => self.postMessage({ type: 'worker-ready' })); // hata olsa da UI'yi bloke etme

self.onmessage = function(e) {
  const { type, code, run } = e.data;

  if (type === 'compile') {
    handleCompile(code, run);
    return;
  }

  if (type === 'cancel') {
    _cancelled = true;
    self.postMessage({ type: 'run-cancel' });
    return;
  }
};
