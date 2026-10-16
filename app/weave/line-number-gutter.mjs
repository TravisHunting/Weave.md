import {gutter, GutterMarker, ViewPlugin} from '@codemirror/view';
import {Facet} from '@codemirror/state';

// Lines hidden outside the document (OKF frontmatter) still count in the file.
export const lineNumberOffset = Facet.define({combine: values => values[0] || 0});

class SourceLineNumber extends GutterMarker {
  constructor(number, offset = 0) {super(); this.number = number; this.offset = offset;}
  eq(other) {return this.number === other.number && this.offset === other.offset;}
  toDOM() {
    const number = document.createElement('span');
    number.className = 'source-line-number'; number.dataset.sourceLine = String(this.number);
    number.textContent = this.number ? String(this.number + this.offset) : '00000';
    return number;
  }
}

// Align the number's line box with the first rendered text line. Measuring the
// DOM also handles headings, code fonts, wrapped rows and zoom without assuming
// that the gutter font has the same ascent or line height as article text.
export const sourceLineNumbers = [
  gutter({class:'cm-lineNumbers',
    lineMarker:(view, line) => new SourceLineNumber(view.state.doc.lineAt(line.from).number, view.state.facet(lineNumberOffset)),
    lineMarkerChange:update => update.startState.facet(lineNumberOffset) !== update.state.facet(lineNumberOffset),
    initialSpacer:() => new SourceLineNumber(0),
  }),
  ViewPlugin.fromClass(class {
    // Gutter rows are rebuilt and resized outside ordinary updates (wrapping,
    // fonts loading, panes appearing), so positions are re-measured whenever
    // the gutter's DOM, the content size or the loaded fonts change.
    constructor(view) {
      this.view = view; this.measure();
      this.mutations = new MutationObserver(() => this.measure());
      this.mutations.observe(view.dom, {childList: true, subtree: true});
      this.resize = new ResizeObserver(() => this.measure()); this.resize.observe(view.contentDOM);
      document.fonts?.ready.then(() => this.measure());
    }
    update() {this.measure();}
    destroy() {this.mutations.disconnect(); this.resize.disconnect();}
    measure() {
      this.view.requestMeasure({key:this,
        read:view => [...view.dom.querySelectorAll('.source-line-number')].flatMap(element => {
          const number = Number(element.dataset.sourceLine);
          if (!number || number > view.state.doc.lines) return [];
          const line = view.state.doc.line(number), position = view.domAtPos(line.from);
          const row = (position.node.nodeType === 1 ? position.node : position.node.parentElement).closest('.cm-line');
          let centre = null;
          if (row) {
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT), range = document.createRange();
            while (walker.nextNode()) if (walker.currentNode.nodeValue.trim()) {
              range.selectNodeContents(walker.currentNode);
              const rect = range.getClientRects()[0];
              if (rect) centre = (rect.top + rect.bottom) / 2;
              break;
            }
          }
          // Empty lines have no glyphs: use the caret box of the line start.
          if (centre === null) {const coords = view.coordsAtPos(line.from, 1); if (!coords) return []; centre = (coords.top + coords.bottom) / 2;}
          return [{element, top: centre - element.parentElement.getBoundingClientRect().top}];
        }),
        write:rows => {for (const {element, top} of rows) element.style.top = top + 'px';},
      });
    }
  }),
];
