import type { TitleObservation } from './contracts';

export type WatchPlan = 'none' | 'want' | 'pass';
/** An explicit seen flag and a separate future plan. These choices never expire. */
export interface TitleMark {
  observation: TitleObservation;
  watched: boolean;
  plan: WatchPlan;
  changedAt: number;
  revision: number;
  operationId: string;
}
export interface MarksSnapshot { marks: TitleMark[]; epoch: number }
export interface MarkMutation { mark: TitleMark; epoch: number }
export interface MarkPatch { watched?: boolean; plan?: WatchPlan }
export const hasMarks = (mark: Pick<TitleMark, 'watched' | 'plan'>): boolean => mark.watched || mark.plan !== 'none';
export const markLabel = (mark: Pick<TitleMark, 'watched' | 'plan'>): string => {
  const plan = mark.plan === 'want' ? 'Want to watch' : mark.plan === 'pass' ? 'Won’t watch' : '';
  return [mark.watched ? 'Watched' : '', plan].filter(Boolean).join(' · ') || 'No marks';
};
