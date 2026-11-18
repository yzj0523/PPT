import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fromBufferPromise } from 'yauzl';

export const maxSourceFileBytes = 20 * 1024 * 1024;
export const maxPdfPages = 200;
export const defaultDocxUnpackedBytes = 64 * 1024 * 1024;

export type SourceFormat = 'pdf' | 'docx';
export type SourceSection = { number: number; text: string };

const errors = {
  missing_filename: '文件缺少名称，请重新选择文件。',
  unsupported_format: '仅支持 PDF 或 DOCX 文件。',
  format_mismatch: '文件实际格式与扩展名不符。',
  file_too_large: '文件超过 20 MiB 上限。',
  staging_capacity: '待解析文件已达到暂存上限，请分批重试。',
  pdf_page_limit: 'PDF 超过 200 页上限。',
  docx_unpack_limit: 'DOCX 超过解包体积上限。',
  encrypted_file: '文件已加密，无法解析。',
  invalid_file: '文件已损坏或无法解析。',
  empty_text: '文件没有可提取的文字。',
  parse_failed: '文件解析失败，请重新上传。',
};

type SourceErrorCode = keyof typeof errors;

export function sourceError(code: SourceErrorCode) {
  return { code, message: errors[code] };
}

export class SourceParseError extends Error {
  readonly code: SourceErrorCode;

  constructor(code: SourceErrorCode, cause?: unknown) {
    super(errors[code], { cause });
    this.code = code;
  }
}

const pdfPackage = import.meta.resolve('pdfjs-dist/package.json');
const pdfAssets = {
  cMapUrl: fileURLToPath(new URL('./cmaps/', pdfPackage)).replaceAll('\\', '/'),
  standardFontDataUrl: fileURLToPath(new URL('./standard_fonts/', pdfPackage)).replaceAll('\\', '/'),
};

async function parsePdf(bytes: Buffer): Promise<SourceSection[]> {
  if (!bytes.subarray(0, 1024).includes('%PDF-')) {
    throw new SourceParseError('format_mismatch');
  }

  const loading = getDocument({
    data: new Uint8Array(bytes),
    ...pdfAssets,
    stopAtErrors: true,
    useWorkerFetch: false,
    useWasm: false,
  });
  try {
    const pdf = await loading.promise;
    if ((await pdf.getPermissions()) !== null) {
      throw new SourceParseError('encrypted_file');
    }
    if (pdf.numPages > maxPdfPages) {
      throw new SourceParseError('pdf_page_limit');
    }

    const sections: SourceSection[] = [];
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const page = await pdf.getPage(number);
      const { items } = await page.getTextContent();
      const text = items.flatMap((item) => 'str' in item ? [item.str, item.hasEOL ? '\n' : ' '] : [])
        .join('').trim();
      if (text) sections.push({ number, text });
      page.cleanup();
    }
    return sections;
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') {
      throw new SourceParseError('encrypted_file');
    }
    throw error;
  } finally {
    await loading.destroy();
  }
}

const oleHeader = Buffer.from('d0cf11e0a1b11ae1', 'hex');
const zipHeader = Buffer.from('504b0304', 'hex');
const wordDocumentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function xmlEncoding(bytes: Buffer) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0x3c && bytes[1] === 0)) return 'utf-16le';
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0 && bytes[1] === 0x3c)) return 'utf-16be';
  return 'utf-8';
}

async function validateDocxPackage(bytes: Buffer, maxUnpackedBytes: number) {
  if (bytes.subarray(0, oleHeader.length).equals(oleHeader) &&
      bytes.includes(Buffer.from('EncryptionInfo\0', 'utf16le')) &&
      bytes.includes(Buffer.from('EncryptedPackage\0', 'utf16le'))) {
    throw new SourceParseError('encrypted_file');
  }
  if (!bytes.subarray(0, zipHeader.length).equals(zipHeader)) {
    throw new SourceParseError('format_mismatch');
  }

  const zip = await fromBufferPromise(bytes, { autoClose: false, validateEntrySizes: true });
  const normalized = new Map<string, string>();
  try {
    let unpackedBytes = 0;
    let encodingDelta = 0;
    let isWordDocument = false;
    for await (const entry of zip.eachEntry()) {
      if (entry.isEncrypted()) throw new SourceParseError('encrypted_file');
      unpackedBytes += entry.uncompressedSize;
      if (unpackedBytes > maxUnpackedBytes || unpackedBytes + encodingDelta > maxUnpackedBytes) {
        throw new SourceParseError('docx_unpack_limit');
      }

      const xml: Buffer[] | undefined = /\.(?:xml|rels)$/i.test(entry.fileName) ? [] : undefined;
      const stream = await zip.openReadStreamPromise(entry);
      let checksum = 0;
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        checksum = crc32(chunk, checksum);
        xml?.push(chunk);
      }
      if (checksum !== entry.crc32) throw new SourceParseError('invalid_file');
      if (xml) {
        const contents = Buffer.concat(xml);
        const encoding = xmlEncoding(contents);
        if (encoding !== 'utf-8' || entry.fileName === '[Content_Types].xml') {
          const decoded = new TextDecoder(encoding, { fatal: true }).decode(contents);
          if (entry.fileName === '[Content_Types].xml') isWordDocument = decoded.includes(wordDocumentType);
          if (encoding !== 'utf-8') {
            // Mammoth's parser expects UTF-8 for all OOXML parts, including relationships.
            const utf8 = decoded.replace(/^(<\?xml\b[^?]*?\bencoding\s*=\s*)["'][^"']+["']/i, '$1"UTF-8"');
            encodingDelta += Buffer.byteLength(utf8) - contents.length;
            if (unpackedBytes + encodingDelta > maxUnpackedBytes) throw new SourceParseError('docx_unpack_limit');
            normalized.set(entry.fileName, utf8);
          }
        }
      }
    }
    if (!isWordDocument) throw new SourceParseError('format_mismatch');
  } finally {
    zip.close();
  }
  if (!normalized.size) return bytes;
  const archive = await JSZip.loadAsync(bytes);
  for (const [name, xml] of normalized) archive.file(name, xml);
  return archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

type WordNode = { type: string; value?: string; children?: WordNode[] };

function readWordText(node: WordNode): string {
  if (node.type === 'text') return node.value ?? '';
  if (node.type === 'tab') return '\t';
  if (node.type === 'break') return '\n';
  return node.children?.map(readWordText).join('') ?? '';
}

async function parseDocx(bytes: Buffer, maxUnpackedBytes: number): Promise<SourceSection[]> {
  const validatedBytes = await validateDocxPackage(bytes, maxUnpackedBytes);
  const sections: SourceSection[] = [];
  let number = 0;

  function collectParagraphs(node: WordNode) {
    if (node.type === 'paragraph') {
      number += 1;
      const text = readWordText(node).trim();
      if (text) sections.push({ number, text });
      return;
    }
    node.children?.forEach(collectParagraphs);
  }

  await mammoth.convertToHtml({ buffer: validatedBytes }, {
    externalFileAccess: false,
    includeEmbeddedStyleMap: false,
    transformDocument(document: WordNode) {
      collectParagraphs(document);
      // Extract from the document tree without rendering the document as HTML.
      return { ...document, children: [] };
    },
  });
  return sections;
}

export async function parseSource(bytes: Buffer, format: SourceFormat, maxDocxUnpackedBytes: number) {
  try {
    const sections = format === 'pdf' ? await parsePdf(bytes) : await parseDocx(bytes, maxDocxUnpackedBytes);
    if (!sections.length) throw new SourceParseError('empty_text');
    return sections;
  } catch (error) {
    if (error instanceof SourceParseError) throw error;
    throw new SourceParseError('invalid_file', error);
  }
}
