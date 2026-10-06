/** Limited emphasis only. All content remains React text, never HTML. */
export function agentTextParts(text: string): { text: string; strong: boolean }[] {
  return text.split(/(\*\*[^*\n]+\*\*)/g).filter(Boolean).map(part => {
    const strong = /^\*\*[^*\n]+\*\*$/.test(part);
    return { text: strong ? part.slice(2, -2) : part, strong };
  });
}
