import { WhatsAppTemplate } from './api';

// Content API template bodies use {{1}}, {{2}}, ... placeholders.
// Given a template and the agent's variable inputs, produce the rendered preview.
export function renderPreview(template: WhatsAppTemplate, values: Record<string, string>): string {
  return template.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    return value && value.length > 0 ? value : `{{${key}}}`;
  });
}

// A template is ready to send only when every declared variable has a non-empty value.
export function isTemplateReady(template: WhatsAppTemplate, values: Record<string, string>): boolean {
  return template.variables.every((v) => (values[v.key] || '').trim().length > 0);
}
