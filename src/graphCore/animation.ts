export interface GraphAnimationPolicy {
  animation: false;
  animationDuration: 0;
  animationDurationUpdate: 0;
}

export function withoutGraphAnimation<T extends Record<string, unknown>>(option: T): T & GraphAnimationPolicy {
  return {
    ...option,
    animation: false,
    animationDuration: 0,
    animationDurationUpdate: 0,
  };
}