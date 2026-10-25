import type { ComponentChildren } from 'preact';

interface WizardProps {
  title: string;
  subtitle: string;
  steps: string[];
  step: number;
  onStep: (step: number) => void;
  children: ComponentChildren;
  /** Content for the last step's primary action; earlier steps get Next. */
  finish: ComponentChildren;
  aside?: ComponentChildren;
}

/** Shared layout for Sunsama's step-by-step rituals. */
export const Wizard = ({ title, subtitle, steps, step, onStep, children, finish, aside }: WizardProps) => (
  <section class="view ritual">
    <header class="view-header">
      <h1>{title}</h1>
      <span class="view-sub">{subtitle}</span>
    </header>
    <ol class="ritual-steps" aria-label={`${title} steps`}>
      {steps.map((label, index) => (
        <li key={label} class={index === step ? 'is-current' : index < step ? 'is-done' : ''}>
          <button aria-current={index === step ? 'step' : undefined} onClick={() => onStep(index)}>
            <span class="step-index">{index + 1}</span>
            {label}
          </button>
        </li>
      ))}
    </ol>
    <div class={`ritual-layout${aside ? ' has-aside' : ''}`}>
      <div class="ritual-body">{children}</div>
      {aside && <aside class="side-panel ritual-aside">{aside}</aside>}
    </div>
    <footer class="ritual-footer">
      {step > 0 && <button onClick={() => onStep(step - 1)}>Back</button>}
      <div class="nav-spacer" />
      {step < steps.length - 1 ? <button class="primary" onClick={() => onStep(step + 1)}>Next</button> : finish}
    </footer>
  </section>
);
