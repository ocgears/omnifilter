import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

@Component({
  selector: 'of-not-found',
  imports: [RouterLink],
  template: `
    <section class="card not-found">
      <h1>Page not found</h1>
      <p>There's nothing at this address. <a routerLink="/home">Go to your photos</a>.</p>
      <img src="/images/filter.jpg" alt="A camera filter" />
    </section>
  `,
  styles: `
    .not-found {
      max-width: 32rem;
      margin: 0 auto;
      text-align: center;
    }
    img {
      max-width: 100%;
      height: auto;
      border-radius: var(--radius);
    }
  `,
})
export class NotFound {}
