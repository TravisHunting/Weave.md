// Obsidian-style highlights: ==text== parses as a `Highlight` node with
// `HighlightMark` delimiters, flanked exactly like GFM's ~~strikethrough~~, so
// live preview, formatting toggles and caret movement treat it like emphasis.
import {tags} from '@lezer/highlight';

const HighlightDelim = {resolve: 'Highlight', mark: 'HighlightMark'};
const Punctuation = /[\p{S}\p{P}]/u;

export const Highlight = {
  defineNodes: [{name: 'Highlight', style: {'Highlight/...': tags.special(tags.content)}}, {name: 'HighlightMark', style: tags.processingInstruction}],
  parseInline: [{
    name: 'Highlight',
    parse(cx, next, pos) {
      if (next !== 61 /* '=' */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      const pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !sAfter && (!pAfter || sBefore || pBefore), !sBefore && (!pBefore || sAfter || pAfter));
    },
    after: 'Emphasis'
  }]
};

// Underlines use the HTML tags that GitHub, VS Code and Obsidian already render:
// <u>text</u> parses as an `Underline` node whose tags are `UnderlineMark`
// delimiters, so they hide and edit like bold marks instead of raw HTML.
export const UNDERLINE_OPEN = '<u>', UNDERLINE_CLOSE = '</u>';
const UnderlineDelim = {resolve: 'Underline', mark: 'UnderlineMark'};

export const Underline = {
  defineNodes: [{name: 'Underline', style: {'Underline/...': tags.special(tags.content)}}, {name: 'UnderlineMark', style: tags.processingInstruction}],
  parseInline: [{
    name: 'Underline',
    parse(cx, next, pos) {
      if (next !== 60 /* '<' */) return -1;
      if (cx.slice(pos, pos + 3) === UNDERLINE_OPEN) return cx.addDelimiter(UnderlineDelim, pos, pos + 3, true, false);
      if (cx.slice(pos, pos + 4) === UNDERLINE_CLOSE) return cx.addDelimiter(UnderlineDelim, pos, pos + 4, false, true);
      return -1;
    },
    before: 'HTMLTag'
  }]
};
