<script setup lang="ts">
import { autocompletion, type Completion, type CompletionContext } from "@codemirror/autocomplete";
import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { basicSetup, EditorView } from "codemirror";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps<{
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const editorHost = ref<HTMLDivElement | null>(null);
let editorView: EditorView | null = null;

const jsGlobals: Completion[] = [
  { label: "document", type: "variable", detail: "Document", boost: 2 },
  { label: "window", type: "variable", detail: "Window" },
  { label: "console", type: "variable", detail: "Console" },
  { label: "navigator", type: "variable", detail: "Navigator" },
  { label: "location", type: "variable", detail: "Location" },
  { label: "localStorage", type: "variable", detail: "Storage" },
  { label: "sessionStorage", type: "variable", detail: "Storage" },
  { label: "history", type: "variable", detail: "History" },
  { label: "fetch", type: "function", detail: "(url, options?) => Promise<Response>" },
  { label: "setTimeout", type: "function", detail: "(fn, ms) => number" },
  { label: "setInterval", type: "function", detail: "(fn, ms) => number" },
  { label: "clearTimeout", type: "function", detail: "(id) => void" },
  { label: "clearInterval", type: "function", detail: "(id) => void" },
  { label: "requestAnimationFrame", type: "function", detail: "(cb) => number" },
  { label: "AbortController", type: "class" },
  { label: "URL", type: "class" },
  { label: "URLSearchParams", type: "class" },
  { label: "Headers", type: "class" },
  { label: "Request", type: "class" },
  { label: "Response", type: "class" },
  { label: "FormData", type: "class" },
  { label: "Blob", type: "class" },
  { label: "console.log", type: "function", detail: "(...args) => void" },
  { label: "console.error", type: "function", detail: "(...args) => void" },
  { label: "console.warn", type: "function", detail: "(...args) => void" },
  { label: "console.info", type: "function", detail: "(...args) => void" },
  { label: "console.table", type: "function", detail: "(data) => void" },
  { label: "console.dir", type: "function", detail: "(obj) => void" },
  { label: "console.time", type: "function", detail: "(label) => void" },
  { label: "console.timeEnd", type: "function", detail: "(label) => void" },
  { label: "JSON.parse", type: "function", detail: "(text) => any" },
  { label: "JSON.stringify", type: "function", detail: "(value, replacer?, space?) => string" },
  { label: "Math.random", type: "function", detail: "() => number" },
  { label: "Math.floor", type: "function", detail: "(x) => number" },
  { label: "Math.ceil", type: "function", detail: "(x) => number" },
  { label: "Math.round", type: "function", detail: "(x) => number" },
  { label: "Math.max", type: "function", detail: "(...values) => number" },
  { label: "Math.min", type: "function", detail: "(...values) => number" },
  { label: "Math.abs", type: "function", detail: "(x) => number" },
  { label: "Object.keys", type: "function", detail: "(obj) => string[]" },
  { label: "Object.values", type: "function", detail: "(obj) => any[]" },
  { label: "Object.entries", type: "function", detail: "(obj) => [string, any][]" },
  { label: "Object.assign", type: "function", detail: "(target, ...sources) => any" },
  { label: "Object.freeze", type: "function", detail: "(obj) => obj" },
  { label: "Array.isArray", type: "function", detail: "(value) => boolean" },
  { label: "Array.from", type: "function", detail: "(iterable) => any[]" },
  { label: "Promise", type: "class" },
  { label: "Promise.resolve", type: "function", detail: "(value) => Promise" },
  { label: "Promise.reject", type: "function", detail: "(reason) => Promise" },
  { label: "Promise.all", type: "function", detail: "(promises) => Promise" },
  { label: "Promise.allSettled", type: "function", detail: "(promises) => Promise" },
  { label: "Promise.race", type: "function", detail: "(promises) => Promise" },
  {
    label: "document.querySelector",
    type: "function",
    detail: "(selector) => Element|null",
    boost: 3,
  },
  {
    label: "document.querySelectorAll",
    type: "function",
    detail: "(selector) => NodeList",
    boost: 3,
  },
  { label: "document.getElementById", type: "function", detail: "(id) => Element|null" },
  { label: "document.createElement", type: "function", detail: "(tag) => Element" },
  { label: "document.body", type: "property", detail: "HTMLBodyElement" },
  { label: "document.title", type: "property", detail: "string" },
  { label: "document.cookie", type: "property", detail: "string" },
  { label: "addEventListener", type: "function", detail: "(type, listener) => void" },
  { label: "removeEventListener", type: "function", detail: "(type, listener) => void" },
  { label: "getAttribute", type: "function", detail: "(name) => string|null" },
  { label: "setAttribute", type: "function", detail: "(name, value) => void" },
  { label: "innerHTML", type: "property", detail: "string" },
  { label: "innerText", type: "property", detail: "string" },
  { label: "textContent", type: "property", detail: "string|null" },
  { label: "classList", type: "property", detail: "DOMTokenList" },
  { label: "style", type: "property", detail: "CSSStyleDeclaration" },
  { label: "parentElement", type: "property", detail: "Element|null" },
  { label: "children", type: "property", detail: "HTMLCollection" },
  { label: "nextElementSibling", type: "property", detail: "Element|null" },
  { label: "page", type: "variable", detail: "Stagehand Page", boost: 5 },
  { label: "page.goto", type: "function", detail: "(url, options?) => Promise", boost: 4 },
  { label: "page.click", type: "function", detail: "(selector) => Promise", boost: 4 },
  { label: "page.type", type: "function", detail: "(selector, text) => Promise" },
  { label: "page.waitForSelector", type: "function", detail: "(selector, options?) => Promise" },
  { label: "page.evaluate", type: "function", detail: "(fn, ...args) => Promise<any>", boost: 4 },
  { label: "page.$$eval", type: "function", detail: "(selector, fn) => Promise<any>" },
  { label: "page.$eval", type: "function", detail: "(selector, fn) => Promise<any>" },
  { label: "page.$$", type: "function", detail: "(selector) => Promise<ElementHandle[]>" },
  { label: "page.$", type: "function", detail: "(selector) => Promise<ElementHandle|null>" },
  { label: "page.url", type: "function", detail: "() => string" },
  { label: "page.title", type: "function", detail: "() => Promise<string>" },
  { label: "page.content", type: "function", detail: "() => Promise<string>" },
  { label: "page.waitForNavigation", type: "function", detail: "(options?) => Promise" },
  { label: "page.waitForTimeout", type: "function", detail: "(ms) => Promise" },
  { label: "page.screenshot", type: "function", detail: "(options?) => Promise<Buffer>" },
  { label: "page.setViewport", type: "function", detail: "(viewport) => Promise" },
  { label: "page.keyboard", type: "property", detail: "Keyboard" },
  { label: "page.mouse", type: "property", detail: "Mouse" },
  { label: "async", type: "keyword" },
  { label: "await", type: "keyword" },
  { label: "export", type: "keyword" },
  { label: "import", type: "keyword" },
  { label: "const", type: "keyword" },
  { label: "let", type: "keyword" },
  { label: "function", type: "keyword" },
  { label: "return", type: "keyword" },
  { label: "throw", type: "keyword" },
  { label: "try", type: "keyword" },
  { label: "catch", type: "keyword" },
  { label: "finally", type: "keyword" },
  { label: "for", type: "keyword" },
  { label: "while", type: "keyword" },
  { label: "if", type: "keyword" },
  { label: "else", type: "keyword" },
  { label: "switch", type: "keyword" },
  { label: "case", type: "keyword" },
  { label: "break", type: "keyword" },
  { label: "continue", type: "keyword" },
  { label: "typeof", type: "keyword" },
  { label: "instanceof", type: "keyword" },
  { label: "new", type: "keyword" },
  { label: "delete", type: "keyword" },
  { label: "void", type: "keyword" },
  { label: "null", type: "keyword" },
  { label: "undefined", type: "keyword" },
  { label: "true", type: "keyword" },
  { label: "false", type: "keyword" },
];

const jsGlobalCompletion = (context: CompletionContext) => {
  const word = context.matchBefore(/[\w.$]*/);
  if (!word || (word.from === word.to && !context.explicit)) return null;
  return { from: word.from, options: jsGlobals };
};

onMounted(() => {
  if (!editorHost.value) return;

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      basicSetup,
      javascript(),
      oneDark,
      autocompletion({ override: [jsGlobalCompletion] }),
      EditorView.contentAttributes.of({
        "aria-label": "JavaScript / MJS 脚本编辑器",
        spellcheck: "false",
      }),
      EditorView.domEventHandlers({
        keydown(event, view) {
          if (event.key !== "Tab") return false;
          event.preventDefault();
          view.dispatch({
            ...view.state.replaceSelection("  "),
            scrollIntoView: true,
          });
          return true;
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          emit("update:modelValue", update.state.doc.toString());
        }
      }),
    ],
  });

  editorView = new EditorView({ state, parent: editorHost.value });
});

watch(
  () => props.modelValue,
  (value) => {
    if (!editorView || editorView.state.doc.toString() === value) return;
    editorView.dispatch({
      changes: { from: 0, to: editorView.state.doc.length, insert: value },
    });
  },
);

onBeforeUnmount(() => {
  editorView?.destroy();
  editorView = null;
});
</script>

<template>
  <div class="editor-container">
    <div ref="editorHost" class="cm-editor-wrap"></div>
  </div>
</template>

<style scoped>
.editor-container {
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.cm-editor-wrap {
  min-height: 260px;
}

.cm-editor-wrap :deep(.cm-editor) {
  min-height: 260px;
  font-size: 0.9rem;
  line-height: 1.5;
}

.cm-editor-wrap :deep(.cm-editor.cm-focused) {
  outline: none;
}

.cm-editor-wrap :deep(.cm-scroller) {
  min-height: 260px;
  resize: vertical;
  overflow: auto;
}
</style>
