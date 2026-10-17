import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

// A request made with the sign-in token that the server turns away with a
// 401 means the token has expired (they last a week) or been signed out
// elsewhere (a password change): forget it, and ask its owner to sign in
// again, rather than leaving every later request to fail.
export const expiredSignIn: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((err) => {
      const token = req.headers.get('token');
      // Only for the token still in use, not one already replaced.
      if (
        err instanceof HttpErrorResponse &&
        err.status === 401 &&
        token &&
        auth.token() === token
      ) {
        auth.expired();
        router.navigateByUrl('/signin');
      }
      return throwError(() => err);
    }),
  );
};
