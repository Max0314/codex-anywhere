import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MessageMarkdown } from '../web/src/message-markdown.js';
import { ThreadReferenceContext } from '../web/src/thread-references.js';

const id = '01a21755-294d-79f2-9169-58434888ddb3';
const second = '01a21780-8c2f-74d3-a6b0-9b9cc50f94f0';
const marker = (key: string) => '::created-thread{threadId="' + key + '"}';
const render = (text: string, streaming = false, threadReferences = true) => renderToStaticMarkup(
  createElement(ThreadReferenceContext.Provider, { value: {
    childIds: new Set([id]), sessions: [{ id: second, title: '关联项目' }], open: async () => {},
  } }, createElement(MessageMarkdown, { text, threadReferences, streaming, onDownloadFile: () => {} })),
);

test('a desktop reply hides raw refs, deduplicates visible subagents and keeps a named link', () => {
  const html = render('已完成。\n\n' + marker(id) + ' ' + marker(second) + ' ' + marker(second));
  assert.match(html, /已完成/);
  assert.match(html, /关联项目/);
  assert.equal(html.split('关联项目').length, 3);
  assert.doesNotMatch(html, /created-thread|58434888ddb3/);
});

test('message clipboard text, examples, and incomplete streamed directives remain distinct', () => {
  const raw = marker(second);
  assert.match(render(raw, false, false), /created-thread/);
  assert.match(render(String.fromCharCode(96) + raw + String.fromCharCode(96)), /<code>::created-thread/);
  assert.doesNotMatch(render('已完成。 ' + raw.slice(0, 30), true), /created-thread/);
  assert.match(render('已完成。 ' + raw.slice(0, 30)), /created-thread/);
});
