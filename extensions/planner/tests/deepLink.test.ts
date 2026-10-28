import { describe, expect, test } from 'bun:test';
import { ROUTES, isNewTabClick, parseRoute, routeOf } from '../panel/lib/deepLink.ts';

describe('deep links into the Planner page', () => {
  test('a page, a task over it, or a Linear issue over it, there and back', () => {
    expect(routeOf({ page: 'calendar' })).toBe('/calendar');
    expect(routeOf({ page: 'today', openTaskId: '0mvq3k2abc' })).toBe('/today?task=0mvq3k2abc');
    expect(routeOf({ page: 'linear', openIssue: { id: 'e7f3c1d2-9a', workspaceId: 'ws-1' } })).toBe('/linear?issue=e7f3c1d2-9a&workspace=ws-1');
    // An issue wins over a task: the issue editor sits above any task detail.
    expect(routeOf({ page: 'linear', openTaskId: 't1', openIssue: { id: 'i1', workspaceId: null } })).toBe('/linear?issue=i1');
    for (const page of ROUTES) expect(parseRoute(routeOf({ page }))).toEqual({ page, openTaskId: null, openIssue: null });
    expect(parseRoute('/today?task=0mvq3k2abc')).toEqual({ page: 'today', openTaskId: '0mvq3k2abc', openIssue: null });
    expect(parseRoute('/linear?issue=e7f3c1d2-9a&workspace=ws-1')).toEqual({ page: 'linear', openTaskId: null, openIssue: { id: 'e7f3c1d2-9a', workspaceId: 'ws-1' } });
  });

  test('anything that names nothing the Planner has is left alone', () => {
    for (const route of [null, '', '/', 'calendar', '/nowhere', '/calendar/x', 'javascript:alert(1)', '//evil.example/home']) {
      expect(parseRoute(route)).toBeNull();
    }
    // A task id that can't be one keeps the page and drops the task.
    for (const route of ['/today?task=a b', `/today?task=${'x'.repeat(201)}`]) {
      expect(parseRoute(route)).toEqual({ page: 'today', openTaskId: null, openIssue: null });
    }
    // A bad workspace id drops only the workspace.
    expect(parseRoute('/linear?issue=i1&workspace=<x>')).toEqual({ page: 'linear', openTaskId: null, openIssue: { id: 'i1', workspaceId: null } });
  });

  test('Cmd/Ctrl/Shift-click and the middle button open a new tab; a plain click does not', () => {
    const click = (patch: Partial<MouseEvent>) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, ...patch });
    expect(isNewTabClick(click({}))).toBe(false);
    expect(isNewTabClick(click({ metaKey: true }))).toBe(true);
    expect(isNewTabClick(click({ ctrlKey: true }))).toBe(true);
    expect(isNewTabClick(click({ shiftKey: true }))).toBe(true);
    expect(isNewTabClick(click({ button: 1 }))).toBe(true);
    expect(isNewTabClick(click({ button: 2, ctrlKey: true }))).toBe(false);
  });
});
