import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '../services/toast/toast.service';
import { AuthenticationService } from './services/authentication.service';
import { SKIP_ERROR_TOAST } from './skip-error-toast.context';
import { tokenInterceptor } from './token.interceptor';

const URL = 'https://test.api/reservations';

describe('tokenInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let toastService: jasmine.SpyObj<ToastService>;

  beforeEach(() => {
    toastService = jasmine.createSpyObj<ToastService>('ToastService', ['error']);
    const authService = jasmine.createSpyObj<AuthenticationService>('AuthenticationService', [
      'getTokens',
    ]);
    authService.getTokens.and.returnValue(null);

    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([tokenInterceptor])),
        provideHttpClientTesting(),
        { provide: ToastService, useValue: toastService },
        { provide: AuthenticationService, useValue: authService },
      ],
    });

    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('shows the server message in a toast for a 400 response', () => {
    http.post(URL, {}).subscribe({ error: () => undefined });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).toHaveBeenCalledWith('Overlaps', 'Error');
  });

  it('does not show a toast but still rethrows when SKIP_ERROR_TOAST is set', () => {
    let receivedStatus: number | undefined;
    http
      .post(URL, {}, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) })
      .subscribe({ error: (error) => (receivedStatus = error.status) });

    httpMock
      .expectOne(URL)
      .flush({ message: 'Overlaps' }, { status: 400, statusText: 'Bad Request' });

    expect(toastService.error).not.toHaveBeenCalled();
    expect(receivedStatus).toBe(400);
  });

  it('does not show a toast for a guest endpoint when SKIP_ERROR_TOAST is set', () => {
    const url = 'https://test.api/guest/groups/grp-1/status';
    http.get(url, { context: new HttpContext().set(SKIP_ERROR_TOAST, true) }).subscribe({ error: () => undefined });

    httpMock.expectOne(url).flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });

    expect(toastService.error).not.toHaveBeenCalled();
  });

  describe('Cognito token', () => {
    beforeEach(() => {
      const authService = TestBed.inject(AuthenticationService) as jasmine.SpyObj<AuthenticationService>;
      authService.getTokens.and.returnValue({ idToken: 'id-token' } as ReturnType<AuthenticationService['getTokens']>);
    });

    for (const url of ['https://test.api/guest/groups/grp-1/sessions', 'https://test.api/guest/groups/grp-1/sessions/gs-1']) {
      it(`is attached to the owner endpoint ${url}`, () => {
        http.get(url).subscribe();
        const request = httpMock.expectOne(url);
        expect(request.request.headers.get('Authorization')).toBe('Bearer id-token');
        request.flush({});
      });
    }

    it('is not attached to other guest endpoints', () => {
      const url = 'https://test.api/guest/sessions/gs-1';
      http.get(url).subscribe();
      const request = httpMock.expectOne(url);
      expect(request.request.headers.has('Authorization')).toBeFalse();
      request.flush({});
    });
  });
});
