import { AppError } from './ai.ts';
import { object, outputText, text } from './context.ts';
import type { ArtifactSkill } from './jobs.ts';
import { escapeHtml, htmlDocument } from './render.ts';

const missingIssuer = '【待填写发文单位】';
const missingDate = '【待填写日期】';
const printedDate = /(?<!\d)(?:\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}(?!\d)|(?:[\d零〇一二三四五六七八九]{4}\s*年\s*)?[\d零〇一二三四五六七八九十廿]{1,3}\s*月\s*[\d零〇一二三四五六七八九十廿]{1,3}\s*[日号])/gu;
const noticeTitles = new Set(['通知', '活动通知', '会议通知', '工作通知', '报名通知']);
const noticeHeadings = new Set(['正文', '事项', '活动安排', '会议安排', '安排', '参加对象', '报名方式', '注意事项']);

function dateParts(value: string) {
  if (value.replace(/[\d\s年月日号./-]/g, '')) return '';
  return value.match(/\d+/g)?.map(Number).join('-') ?? '';
}

function noticeFields(output: Record<string, unknown>, options: Record<string, unknown>, facts: string[]) {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const knownFacts = [...facts, options.issuer as string, options.date as string].filter(Boolean);
  const evidence = facts.map(normalize);
  const grounded = (value: string) => Boolean(value.trim()) && evidence.some((fact) => fact.includes(normalize(value)));
  const issuerEvidence = new Set(facts.flatMap((fact) => [...fact.matchAll(
    /(?:发文单位|发布单位|签发单位)\s*(?:[：:]|为)\s*([^\r\n，、,。；;]+)|(?:本通知|本公告)由\s*([^\r\n，。；]{2,150}?)(?=发布|印发|发出)/g,
  )].map((match) => normalize(match[1] ?? match[2]))));
  if (options.issuer) issuerEvidence.add(normalize(options.issuer as string));

  const signingDates = facts.flatMap((fact) => [...fact.matchAll(/(?:发文日期|签发日期|发布日期|落款日期)\s*(?:[：:]|为)\s*([^\r\n，、,。；;]+)/g)]
    .map(([, value]) => value.trim()));
  if (options.date) signingDates.push(options.date as string);
  const dates = new Set(knownFacts.flatMap((fact) => [...fact.matchAll(printedDate)].map(([value]) => dateParts(value))));
  const groundedDate = (value: string) => {
    if (grounded(value)) return true;
    const [match] = value.matchAll(printedDate);
    const parts = dateParts(value);
    return match?.[0] === value && Boolean(parts) && dates.has(parts);
  };
  const verifiedSigningDate = (value: string) => {
    if (!value) return false;
    const parts = dateParts(value);
    return signingDates.some((candidate) => normalize(candidate) === normalize(value) ||
      (Boolean(parts) && [...candidate.matchAll(printedDate)].some(([printed]) => dateParts(printed) === parts)));
  };

  const declaredIssuer = typeof output.issuer === 'string' ? output.issuer.trim() : '';
  const declaredDate = typeof output.date === 'string' ? output.date.trim() : '';
  const issuer = options.issuer as string || (declaredIssuer.length <= 150 && issuerEvidence.has(normalize(declaredIssuer)) ? declaredIssuer : missingIssuer);
  const date = options.date as string || (declaredDate.length <= 60 && verifiedSigningDate(declaredDate) ? declaredDate : missingDate);

  function supportedText(value: string): string | undefined {
    if (grounded(value)) return value;

    // The model may choose excerpts or one of these sentences. It cannot add free-text facts.
    const normalized = value.replace(/\s+/g, '');
    if (/^活动通知(?:·)?\{\{issuer\}\}$/i.test(normalized)) return '活动通知 · ' + issuer;
    if (/^本通知由\{\{issuer\}\}发布。?$/i.test(normalized)) return '本通知由' + issuer + '发布。';
    if (/^请留意\{\{date\}\}。?$/i.test(normalized)) return '请留意 ' + date + '。';

    const label = value.match(/^(发文单位|发布单位|签发日期|发布日期|活动日期|安排时间)\s*[：:]\s*([^\r\n。；;]+)[。]?$/);
    if (label) {
      const [, name, candidate] = label;
      const isIssuer = name.endsWith('单位');
      const field = candidate.trim();
      const verified = isIssuer ? issuerEvidence.has(normalize(field)) :
        name === '签发日期' || name === '发布日期' ? verifiedSigningDate(field) : groundedDate(field);
      const confirmed = isIssuer ? issuer : date;
      const placeholder = isIssuer ? missingIssuer : missingDate;
      const slot = isIssuer ? '{{issuer}}' : '{{date}}';
      return name + '：' + (field.toLowerCase() === slot ? confirmed : verified ? field : placeholder);
    }
    return undefined;
  }

  return { issuer, date, supportedText };
}

export const writingSkill: ArtifactSkill = {
  options(body) {
    const mode = text(body.mode, 20) || 'general';
    if (mode !== 'general' && mode !== 'notice') throw new AppError(400, 'invalid_writing_mode', '请选择有效的文稿类型。');
    return { mode, issuer: mode === 'notice' ? text(body.issuer, 150) : '', date: mode === 'notice' ? text(body.date, 60) : '' };
  },
  async generate({ description, fragments, options, partial }, model, signal) {
    const notice = options.mode === 'notice';
    const output = object(await model.complete(
      '撰写中文文稿。返回 title、sections（数组，每项有 heading 和 paragraphs 字符串数组）。' +
      '遵循 description。有材料时以 fragments 为依据。mode 为 notice 时撰写通知，明确事项和相关安排，' +
      '不要猜测日期、单位或其他缺失事实。issuer 和 date 单独返回，只有文本明确提供时才填写。' +
      '通知的具体标题、章节与正文必须是 description 或 fragments 的原文摘录。' +
      '可以使用通用标题、标准章节名，以及「活动通知 · {{issuer}}」「本通知由{{issuer}}发布。」「请留意 {{date}}。」模板。',
      { description, fragments, ...options }, signal,
    ));
    const facts = [description, ...fragments.map(({ text }) => text)].filter(Boolean);
    const fields = notice ? noticeFields(output, options, facts) : undefined;
    const headingText = outputText(output.title, 150);
    const title = fields && !noticeTitles.has(headingText) ? fields.supportedText(headingText) ?? '活动通知' : headingText;
    if (!Array.isArray(output.sections) || !output.sections.length || output.sections.length > 30) {
      throw new AppError(502, 'invalid_writing', '模型没有返回有效的文稿正文。');
    }
    let sections = output.sections.map((value) => {
      const section = object(value);
      if (!Array.isArray(section.paragraphs) || !section.paragraphs.length || section.paragraphs.length > 25) {
        throw new AppError(502, 'invalid_writing', '模型返回的文稿缺少段落。');
      }
      const rawHeading = section.heading ? outputText(section.heading, 150) : '';
      const heading = fields && rawHeading && !noticeHeadings.has(rawHeading) ? fields.supportedText(rawHeading) ?? '' : rawHeading;
      const rawParagraphs = section.paragraphs.map((p) => outputText(p, 6000));
      const paragraphs = fields ? rawParagraphs.flatMap((p) => {
        const supported = fields.supportedText(p);
        return supported ? [supported] : [];
      }) : rawParagraphs;
      return { heading, paragraphs };
    }).filter(({ heading, paragraphs }) => heading || paragraphs.length);
    if (fields && !sections.some(({ paragraphs }) => paragraphs.some((paragraph) => facts.some((fact) => fact.includes(paragraph))))) {
      // Keep the notice useful if the model supplied no verifiable excerpt.
      const paragraphs = [...new Set(fragments.length ? fragments.slice(0, 3).map(({ text }) => text) : [description])].filter(Boolean);
      sections = [{ heading: '事项说明', paragraphs: paragraphs.length ? paragraphs : ['【待填写事项】'] }, ...sections];
    }
    const body = sections.map(({ heading, paragraphs }) => '<section>' + (heading ? '<h2>' + escapeHtml(heading) + '</h2>' : '') +
      paragraphs.map((paragraph) => '<p>' + escapeHtml(paragraph) + '</p>').join('') + '</section>').join('');
    const signature = fields ? '<footer><p>' + escapeHtml(fields.issuer) + '</p><p>' + escapeHtml(fields.date) + '</p></footer>' : '';
    return { title, content: { mode: options.mode, sections, ...(fields ? { issuer: fields.issuer, date: fields.date } : {}) },
      html: htmlDocument(title, (notice ? '<p>通知</p>' : '') + '<h1>' + escapeHtml(title) + '</h1>' +
        (partial ? '<p>本次使用了部分材料。</p>' : '') + body + signature, 'footer{text-align:right;margin-top:2em}section{margin-block:1.5em}') };
  },
};
