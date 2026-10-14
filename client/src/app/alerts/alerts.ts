import { Component, input, output } from '@angular/core';

// A dismissable list of errors or notices.
@Component({
  selector: 'of-alerts',
  template: `
    @if (items().length) {
      <ul class="alerts" [class]="kind()" [attr.role]="kind() === 'error' ? 'alert' : 'status'">
        @for (item of items(); track $index) {
          <li>
            <span>{{ item }}</span>
            <button
              type="button"
              class="icon-button"
              (click)="dismiss.emit($index)"
              aria-label="Dismiss"
            >
              &times;
            </button>
          </li>
        }
      </ul>
    }
  `,
  styles: `
    .alerts {
      list-style: none;
      margin: 0 0 var(--gap);
      padding: 0;
      display: grid;
      gap: 0.5rem;
    }
    li {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.25rem 0.25rem 0.25rem 1rem;
      border-radius: var(--radius);
      border: 1px solid;
    }
    span {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .error li {
      background: var(--error-bg);
      border-color: var(--error-border);
      color: var(--error-text);
    }
    .info li {
      background: var(--info-bg);
      border-color: var(--info-border);
      color: var(--info-text);
    }
  `,
})
export class Alerts {
  readonly items = input.required<readonly string[]>();
  readonly kind = input<'error' | 'info'>('error');
  readonly dismiss = output<number>();
}
