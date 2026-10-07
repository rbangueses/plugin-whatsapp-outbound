import { CSSProperties } from 'react';

export const container: CSSProperties = {
  padding: 24,
  overflow: 'auto',
  height: '100%',
  background: '#f4f4f6',
  boxSizing: 'border-box',
};

export const panel: CSSProperties = {
  background: '#fff',
  borderRadius: 6,
  padding: 24,
  maxWidth: 640,
  boxShadow: '0 1px 2px rgba(0, 0, 0, 0.08)',
};

export const field: CSSProperties = {
  marginBottom: 16,
  display: 'flex',
  flexDirection: 'column',
};

export const label: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  marginBottom: 6,
  color: '#121c2d',
};

export const input: CSSProperties = {
  padding: '8px 10px',
  border: '1px solid #cbd2d9',
  borderRadius: 4,
  fontSize: 14,
};

export const preview: CSSProperties = {
  background: '#dcf8c6',
  borderRadius: 8,
  padding: '12px 14px',
  fontSize: 14,
  whiteSpace: 'pre-wrap',
  lineHeight: 1.45,
  color: '#111b21',
  border: '1px solid #c9e6b7',
};

export const primaryButton = (disabled: boolean): CSSProperties => ({
  background: disabled ? '#a8b4c4' : '#0263e0',
  color: '#fff',
  border: 0,
  borderRadius: 4,
  padding: '10px 16px',
  fontSize: 14,
  cursor: disabled ? 'not-allowed' : 'pointer',
});

export const status = (tone: 'ok' | 'err'): CSSProperties => ({
  marginTop: 12,
  padding: '10px 12px',
  borderRadius: 4,
  fontSize: 13,
  background: tone === 'ok' ? '#e8f5e9' : '#fdecea',
  color: tone === 'ok' ? '#1b5e20' : '#b71c1c',
});
