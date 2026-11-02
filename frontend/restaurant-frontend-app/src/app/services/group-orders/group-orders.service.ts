import { HttpClient, HttpContext } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map, Observable, switchMap } from 'rxjs';
import { SKIP_ERROR_TOAST } from '@app/auth/skip-error-toast.context';
import { GroupSessionsResponse } from '@app/models/group-orders/group-sessions-response.model';
import { GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import { OwnerSessionResponse } from '@app/models/group-orders/owner-session.model';
import { SubmitGroupPreOrderRequest, SubmittedDish } from '@app/models/group-orders/submit-group-pre-order.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GuestInviteService } from '@app/services/reservation/guest-invite.service';
import { API_BASE_URL } from '@app/shared/config/api-base-url.token';

export interface OwnerSessionToken {
  guestSessionId: string;
  sessionToken: string;
  guestName: string;
}

export interface OwnerCartAccess extends OwnerSessionToken {
  inviteToken: string;
}

export interface GroupRequestOptions {
  /** Фоновий запит: помилка не показує toast. */
  silent?: boolean;
}

@Injectable({ providedIn: 'root' })
export class GroupOrdersService {
  private readonly baseUrl = inject(API_BASE_URL);
  private readonly http = inject(HttpClient);
  private readonly guestInviteService = inject(GuestInviteService);

  getGroupInvite$(reservationId: string): Observable<GuestInvite> {
    return this.http.get<GuestInvite>(`${this.baseUrl}/reservations/${encodeURIComponent(reservationId)}/group`);
  }

  /** Токен для власного кошика Owner і адреса гостьової сторінки, де він цей кошик наповнює. */
  openOwnerCart$(reservationId: string): Observable<OwnerCartAccess> {
    return this.http
      .post<OwnerSessionToken>(`${this.baseUrl}/reservations/${encodeURIComponent(reservationId)}/owner-session-token`, null)
      .pipe(
        switchMap((session) =>
          this.guestInviteService.getInviteToken$(reservationId).pipe(map(({ token }) => ({ ...session, inviteToken: token }))),
        ),
      );
  }

  getSessions$(groupReservationId: string, options: GroupRequestOptions = {}): Observable<GroupSessionsResponse> {
    return this.http.get<GroupSessionsResponse>(this.sessionsUrl(groupReservationId), {
      context: this.requestContext(options),
    });
  }

  getOwnerSessionId$(reservationId: string): Observable<string> {
    return this.http
      .get<OwnerSessionResponse>(`${this.baseUrl}/reservations/${encodeURIComponent(reservationId)}/guest-session-id`)
      .pipe(map((response) => response.guestSessionId));
  }

  getStatus$(groupReservationId: string, options: GroupRequestOptions = {}): Observable<GroupStatusResponse> {
    return this.http.get<GroupStatusResponse>(
      `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/status`,
      { context: this.requestContext(options) },
    );
  }

  submit$(groupReservationId: string, reservationId: string): Observable<SubmittedDish[]> {
    const body: SubmitGroupPreOrderRequest = { reservationId };
    return this.http.post<SubmittedDish[]>(
      `${this.baseUrl}/group-reservations/${encodeURIComponent(groupReservationId)}/submit`,
      body,
    );
  }

  removeSession$(groupReservationId: string, guestSessionId: string): Observable<GroupSessionsResponse> {
    return this.http.delete<GroupSessionsResponse>(
      `${this.sessionsUrl(groupReservationId)}/${encodeURIComponent(guestSessionId)}`,
    );
  }

  private sessionsUrl(groupReservationId: string): string {
    return `${this.baseUrl}/guest/groups/${encodeURIComponent(groupReservationId)}/sessions`;
  }

  private requestContext(options: GroupRequestOptions): HttpContext {
    return new HttpContext().set(SKIP_ERROR_TOAST, options.silent === true);
  }
}
