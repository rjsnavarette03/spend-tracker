import { describe, expect, it } from 'vitest';
import { replyBlocks } from './assistantText';

describe('replyBlocks', () => {
  it('keeps plain sentences as one paragraph per blank-line block', () => {
    expect(replyBlocks('You spent ₱1,200.00.\nThat is less than last month.\n\nNice work!')).toEqual([
      { kind: 'p', text: 'You spent ₱1,200.00. That is less than last month.' },
      { kind: 'p', text: 'Nice work!' },
    ]);
  });

  it('groups bullets and numbered lines into lists', () => {
    expect(replyBlocks('Top categories:\n- Groceries ₱3,000.00\n* Dining Out ₱1,200.00\n1. First\n2) Second')).toEqual([
      { kind: 'p', text: 'Top categories:' },
      { kind: 'ul', items: ['Groceries ₱3,000.00', 'Dining Out ₱1,200.00'] },
      { kind: 'ol', items: ['First', 'Second'] },
    ]);
  });

  it('drops Markdown marks the chat does not render', () => {
    expect(replyBlocks('## Summary\n**Total:** `₱500.00`\n- __Food__ ₱300.00')).toEqual([
      { kind: 'p', text: 'Summary' },
      { kind: 'p', text: 'Total: ₱500.00' },
      { kind: 'ul', items: ['Food ₱300.00'] },
    ]);
  });

  it('flattens table rows and skips their rule lines', () => {
    expect(replyBlocks('| Category | Spent |\n|---|---:|\n| Food | ₱300.00 |')).toEqual([
      { kind: 'p', text: 'Category · Spent' },
      { kind: 'p', text: 'Food · ₱300.00' },
    ]);
  });

  it('does not treat a negative amount as a bullet', () => {
    expect(replyBlocks('Your Visa balance is -₱3,200.00.')).toEqual([
      { kind: 'p', text: 'Your Visa balance is -₱3,200.00.' },
    ]);
  });
});
