import type { ReactNode } from 'react';
export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginTop: 12 }}>
    <h3 style={{ marginTop: 0 }}>{title}</h3>
    {children}
  </section>
);
export const Err = ({ msg }: { msg: string | null }) => (msg ? <p role="alert" style={{ color: '#b91c1c' }}>{msg}</p> : null);
