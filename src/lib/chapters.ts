/**
 * 章节切分：流式输出时实时检测 "## " 标题行，维护章节索引。
 */
import type { Chapter } from './types';

export interface ChapterScanner {
  /** 吸收一段新文本，返回本次新检测到的章节（自增 index） */
  feed(text: string): Chapter[];
  /** 当前完整章节索引 */
  list(): Chapter[];
}

/** 创建章节扫描器：跨 chunk 边界处理标题行 */
export function createChapterScanner(): ChapterScanner {
  const chapters: Chapter[] = [];
  let pending: string[] = []; // 尚未闭合的缓冲区，末尾可能是半个标题

  function flushBuffer(): string | null {
    // 将缓冲整行拼接，若最后一行未以换行结尾则保留在 pending
    const joined = pending.join('');
    pending = [];
    const lines = joined.split('\n');
    const incomplete = lines.pop() ?? '';
    if (incomplete.trim() !== '') pending = [incomplete];
    return lines.join('\n') || null;
  }

  return {
    feed(text: string): Chapter[] {
      pending.push(text);
      const block = flushBuffer();
      if (!block) return [];
      const found: Chapter[] = [];
      for (const line of block.split('\n')) {
        const m = /^##\s+(.+)$/.exec(line.trim());
        if (m) {
          const title = m[1].trim();
          const index = chapters.length;
          chapters.push({ index, title });
          found.push({ index, title });
        }
      }
      return found;
    },
    list() {
      // 处理残留缓冲
      if (pending.length) {
        const tail = pending.join('');
        pending = [];
        const m = /^##\s+(.+)$/.exec(tail.trim());
        if (m) chapters.push({ index: chapters.length, title: m[1].trim() });
      }
      return chapters.slice();
    },
  };
}

/** 按 markdown 全文切分章节（生成结束时兜底，双保险） */
export function extractChapters(markdown: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^##\s+(.+)$/.exec(line.trim());
    if (m) chapters.push({ index: chapters.length, title: m[1].trim() });
  }
  return chapters;
}

/** 从 markdown 中提取指定章节的正文文本（从该章节标题到下一章标题） */
export function extractChapterBody(markdown: string, chapterIndex: number): string {
  const lines = markdown.split('\n');
  const headers: number[] = [];
  lines.forEach((l, i) => {
    if (/^##\s+/.test(l.trim())) headers.push(i);
  });
  if (chapterIndex < 0 || chapterIndex >= headers.length) return '';
  const start = headers[chapterIndex];
  const end = headers[chapterIndex + 1] ?? lines.length;
  return lines.slice(start, end).join('\n').trim();
}