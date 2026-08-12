import { describe, expect, it } from 'vitest';
import { isConnectLabel, nameFromConnectLabel, parseCardText } from '../content/linkedinAgentClassify.js';

describe('isConnectLabel', () => {
  it('accepts the plain "Connect" label', () => {
    expect(isConnectLabel('Connect')).toBe(true);
    expect(isConnectLabel('  connect ')).toBe(true);
  });

  it('accepts an "Invite X to connect" aria-label', () => {
    expect(isConnectLabel('Invite Ada Lovelace to connect')).toBe(true);
  });

  it('rejects unrelated labels', () => {
    expect(isConnectLabel('Follow')).toBe(false);
    expect(isConnectLabel('Message')).toBe(false);
    expect(isConnectLabel('')).toBe(false);
    expect(isConnectLabel('Send')).toBe(false); // the SEND modal's button — a different step
  });
});

describe('nameFromConnectLabel', () => {
  it('extracts the name from an Invite label', () => {
    expect(nameFromConnectLabel('Invite Ada Lovelace to connect', 'fallback')).toBe('Ada Lovelace');
  });

  it('falls back when the label carries no name', () => {
    expect(nameFromConnectLabel('Connect', 'Ada Lovelace')).toBe('Ada Lovelace');
  });
});

describe('parseCardText', () => {
  it('splits a "Role at Company" headline', () => {
    const r = parseCardText('Ada Lovelace', 'Robotics Engineer at Acme Robotics');
    expect(r).toEqual({ name: 'Ada Lovelace', headline: 'Robotics Engineer at Acme Robotics', company: 'Acme Robotics' });
  });

  it('splits a "Role @ Company" headline', () => {
    const r = parseCardText('Ada Lovelace', 'Robotics Engineer @ Acme Robotics');
    expect(r.company).toBe('Acme Robotics');
  });

  it('omits company rather than guessing when the shape does not match', () => {
    const r = parseCardText('Ada Lovelace', 'Building robots since 2019');
    expect(r.company).toBeUndefined();
  });

  it('clamps overlong fields', () => {
    const r = parseCardText('x'.repeat(200), 'y'.repeat(300));
    expect(r.name.length).toBeLessThanOrEqual(80);
    expect(r.headline.length).toBeLessThanOrEqual(160);
  });
});
