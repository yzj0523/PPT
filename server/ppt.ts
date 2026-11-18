import { AppError } from './ai.ts';
import { object, outputText, text } from './context.ts';
import type { ArtifactSkill } from './jobs.ts';
import { escapeHtml, htmlDocument } from './render.ts';

const ranges = { short: [4, 6], medium: [7, 10], long: [11, 15] } as const;
type Length = keyof typeof ranges;

export const pptSkill: ArtifactSkill = {
  options(body) {
    const length = text(body.length, 12) || 'medium';
    if (!Object.hasOwn(ranges, length)) throw new AppError(400, 'invalid_length', '请选择有效的演讲文稿篇幅。');
    return { length };
  },
  async generate({ description, fragments, options, partial }, model, signal) {
    const [min, max] = ranges[options.length as Length];
    const output = object(await model.complete(
      '生成中文演讲幻灯片。返回 title 和 slides 数组。每页有 title 和 points（字符串数组）或 body（正文）。' +
      '严格满足 minSlides 到 maxSlides。遵循 description；有参考材料时，使用 fragments 中的事实并标明不确定内容。',
      { description, fragments, minSlides: min, maxSlides: max }, signal,
    ));
    const title = outputText(output.title, 150);
    if (!Array.isArray(output.slides) || output.slides.length < min || output.slides.length > max) {
      throw new AppError(502, 'invalid_slides', '模型返回的幻灯片页数不符合所选篇幅。');
    }
    const slides = output.slides.map((value) => {
      const slide = object(value);
      const heading = outputText(slide.title, 150);
      const body = slide.body === undefined ? '' : outputText(slide.body, 4000);
      const points = Array.isArray(slide.points) && slide.points.length <= 15
        ? slide.points.map((point) => outputText(point, 500)) : [];
      if (!body && !points.length) throw new AppError(502, 'invalid_slides', '有幻灯片缺少正文或要点。');
      return { title: heading, body, points };
    });
    const cards = slides.map((slide, index) => {
      const number = index + 1;
      return '<section class="slide" id="slide-' + number + '"><p class="page">' + number + ' / ' + slides.length +
        '</p><h2>' + escapeHtml(slide.title) + '</h2>' + (slide.body ? '<p>' + escapeHtml(slide.body) + '</p>' : '') +
        (slide.points.length ? '<ul>' + slide.points.map((point) => '<li>' + escapeHtml(point) + '</li>').join('') + '</ul>' : '') +
        '<nav>' + (index ? '<a href="#slide-' + index + '">上一页</a>' : '') +
        (number < slides.length ? '<a href="#slide-' + (number + 1) + '">下一页</a>' : '') + '</nav></section>';
    }).join('');
    const html = htmlDocument(title, '<h1>' + escapeHtml(title) + '</h1>' + (partial ? '<p>本次使用了部分材料。</p>' : '') + cards,
      '.slide{min-height:50vh;background:white;border:1px solid #d9e4de;border-radius:14px;padding:clamp(20px,5vw,54px);margin:20px 0}' +
      '.slide h2{font-size:clamp(22px,4vw,34px)}nav{display:flex;gap:18px}.page{color:#546760}@media print{.slide{break-after:page}nav{display:none}}');
    return { title, html, content: { slides } };
  },
};
