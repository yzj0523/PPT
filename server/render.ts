const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => entities[character]);
}

export function htmlDocument(title: string, content: string, style = '') {
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + escapeHtml(title) + '</title><style>body{font:16px/1.65 system-ui,sans-serif;margin:0;background:#edf5f0;color:#162a29}' +
    'main{max-width:920px;margin:0 auto;padding:clamp(16px,5vw,56px)}h1,h2,h3,p{overflow-wrap:anywhere}' +
    'p{white-space:pre-wrap}a{color:#31665b}li{white-space:pre-wrap;overflow-wrap:anywhere}' + style +
    '</style><main>' + content + '</main></html>';
}
