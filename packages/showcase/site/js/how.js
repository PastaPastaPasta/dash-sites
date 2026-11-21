import { manifest } from './site.js';

manifest().then((data) => {
  document.getElementById('m-files').textContent = String(Object.keys(data.files).length);
  document.getElementById('m-documents').textContent = String(data.chunks.length);
});
