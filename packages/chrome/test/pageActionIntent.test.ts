import { describe, expect, it } from 'vitest';
import { detectPageActionIntent } from '../src/pageActionIntent.js';

describe('detectPageActionIntent — imperative page actions', () => {
  it.each([
    'click the Belgique button',
    'click on the Belgique button',
    'tap the login button',
    'press the submit button',
    'scroll down',
    'type my email into the search box',
    'fill in the search box with hello',
    'enter my name in the field',
    'select France from the dropdown',
    'choose the second option',
    'check the box next to newsletter',
    'uncheck the terms checkbox',
    'toggle dark mode',
    'drag the slider to the right',
    'submit the form',
    'expand the menu',
    'collapse the sidebar',
    'hover over the icon',
    'close the modal',
    'dismiss the popup',
    'pick the blue one',
  ])('matches %j — opens with a known interaction verb', (message) => {
    expect(detectPageActionIntent(message)).toEqual({ instruction: message });
  });

  it.each([
    'please click the submit button',
    'pls scroll down',
    'could you click the login button',
    'can you click the login button?',
    'would you close the modal',
    'will you press the submit button',
  ])('matches %j — a polite lead-in is stripped before checking the verb', (message) => {
    expect(detectPageActionIntent(message)).toEqual({ instruction: message });
  });

  it.each([
    'what happens when I click submit?',
    'what does the Belgique button do',
    'summarize this page',
    'the Belgique button needs to be clicked',
    '',
    '   ',
  ])('does not match %j — no known interaction verb at the start', (message) => {
    expect(detectPageActionIntent(message)).toBeNull();
  });

  it('preserves the original message casing/whitespace as the instruction, trimmed', () => {
    expect(detectPageActionIntent('  Click the Belgique button  ')).toEqual({
      instruction: 'Click the Belgique button',
    });
  });
});
