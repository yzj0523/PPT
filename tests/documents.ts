import JSZip from 'jszip';

export function makePdf(pageTexts: string[]) {
  const pageReferences = pageTexts.map((_, index) => `${4 + index * 2} 0 R`);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageReferences.join(' ')}] /Count ${pageTexts.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const text of pageTexts) {
    const content = text ? `BT /F1 12 Tf 20 40 Td (${text}) Tj ET\n` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
  }

  const rows = ['0000000000 65535 f \n'];
  let file = '%PDF-1.7\n';
  for (const [index, object] of objects.entries()) {
    rows.push(`${String(file.length).padStart(10, '0')} 00000 n \n`);
    file += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = file.length;
  file += `xref\n0 ${rows.length}\n${rows.join('')}trailer\n<< /Size ${rows.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(file);
}

export async function makeDocx(paragraphs: string[][], extraText = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  const body = paragraphs.map((lines) => `<w:p><w:r>${lines.map((line) =>
    `<w:t>${line}</w:t>`).join('<w:br/>')}</w:r></w:p>`).join('');
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>${body}${extraText ? `<!-- ${extraText} -->` : ''}</w:body>
    </w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
