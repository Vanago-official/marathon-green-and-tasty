import { CurrencyPipe, DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { EMPTY, Observable, Subscription, catchError, exhaustMap, filter, finalize, forkJoin, interval, map, switchMap, tap } from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { GroupSessionsResponse } from '@app/models/group-orders/group-sessions-response.model';
import { GroupReservationStatus, GroupStatusResponse } from '@app/models/group-orders/group-status.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';
import { getServerErrorMessage } from '@app/shared/helpers/http-error-helpers';

const SYNC_INTERVAL_MS = 15_000;
const STATUS_LABELS: Record<GroupReservationStatus, string> = {
  Open: 'Collecting pre-orders',
  Submitted: 'Sent to Restaurant',
  Closed: 'Closed',
};

@Component({
  selector: 'app-group-order-page',
  imports: [CurrencyPipe, DatePipe, ModalComponent, ParticipantCardComponent],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly service = inject(GroupOrdersService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly reservationId = this.route.snapshot.paramMap.get('reservationId') ?? '';
  private loadSubscription?: Subscription;
  private syncSubscription?: Subscription;
  /** Зростає після Submit/Remove: відповідь фонового запиту, що вже в дорозі, стала застарілою. */
  private dataVersion = 0;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly notFound = signal(false);
  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly ownerSessionId = signal('');
  readonly status = signal<GroupReservationStatus>('Open');

  readonly confirmingSubmit = signal(false);
  readonly submitting = signal(false);
  readonly guestToRemove = signal<Participant | null>(null);
  readonly removing = signal(false);

  readonly refreshing = signal(false);
  readonly refreshFailed = signal(false);
  readonly lastUpdated = signal<Date | null>(null);

  readonly consolidated = computed(() => consolidatePreOrder(this.participants()));
  readonly isOpen = computed(() => this.status() === 'Open');
  readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  readonly isEmpty = computed(() => this.participants().every((person) => person.items.length === 0));
  readonly pendingCount = computed(() => this.participants().filter((person) => !person.isSubmitted).length);
  readonly canSubmit = computed(() => this.consolidated().items.length > 0 && !this.submitting());

  constructor() {
    this.load();
  }

  addMyDishes(): void {
    this.service
      .openOwnerCart$(this.reservationId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(({ inviteToken, guestSessionId, sessionToken, guestName }) => {
        // Гостьова сторінка відновлює сесію з цих ключів, тож Owner не створює окремого гостя.
        const key = (part: string) => `guestPreorder:${inviteToken}:${part}`;
        localStorage.setItem(key('guestSessionId'), guestSessionId);
        localStorage.setItem(key('guestSessionToken'), sessionToken);
        localStorage.setItem(key('guestName'), guestName);
        void this.router.navigate(['/join', inviteToken]);
      });
  }

  load(): void {
    this.stopSync();
    this.loadSubscription?.unsubscribe();
    this.loading.set(true);
    this.loadError.set(null);
    this.notFound.set(false);

    this.loadSubscription = this.service
      .getGroupInvite$(this.reservationId)
      .pipe(
        // Спершу owner-сесія: бекенд може створити її під час цього запиту, і вона має потрапити в список.
        switchMap((invite) =>
          this.service.getOwnerSessionId$(this.reservationId).pipe(
            switchMap((ownerSessionId) =>
              forkJoin({
                sessions: this.service.getSessions$(invite.GroupReservationId),
                status: this.service.getStatus$(invite.GroupReservationId),
              }).pipe(map((data) => ({ ...data, invite, ownerSessionId }))),
            ),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ invite, ownerSessionId, sessions, status }) => {
          this.invite.set(invite);
          this.ownerSessionId.set(ownerSessionId);
          this.applyLatest(sessions, status);
          this.loading.set(false);
          if (this.isOpen()) {
            this.startSync();
          }
        },
        error: (error: HttpErrorResponse) => {
          this.notFound.set(error.status === 404);
          this.loadError.set(getServerErrorMessage(error) || 'Could not load the group pre-order.');
          this.loading.set(false);
        },
      });
  }

  refresh(): void {
    if (!this.refreshing()) {
      this.fetchLatest$().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
    }
  }

  isOwn(person: Participant): boolean {
    return person.id === this.ownerSessionId();
  }

  closeSubmitDialog(): void {
    if (!this.submitting()) {
      this.confirmingSubmit.set(false);
    }
  }

  confirmSubmit(): void {
    const groupId = this.invite()?.GroupReservationId;
    if (!groupId || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.dataVersion++;

    this.service
      .submit$(groupId, this.reservationId)
      .pipe(
        finalize(() => this.submitting.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.status.set('Submitted');
          this.confirmingSubmit.set(false);
          this.stopSync();
          this.toast.success('Pre-order sent to the restaurant');
        },
        // Toast показує tokenInterceptor.
        error: () => this.confirmingSubmit.set(false),
      });
  }

  closeRemoveDialog(): void {
    if (!this.removing()) {
      this.guestToRemove.set(null);
    }
  }

  confirmRemove(): void {
    const groupId = this.invite()?.GroupReservationId;
    const guest = this.guestToRemove();
    if (!groupId || !guest || this.removing()) {
      return;
    }
    this.removing.set(true);
    this.dataVersion++;

    this.service
      .removeSession$(groupId, guest.id)
      .pipe(
        finalize(() => this.removing.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (sessions) => {
          this.participants.set(sessions.participants);
          this.guestToRemove.set(null);
        },
        // Toast показує tokenInterceptor.
        error: () => this.guestToRemove.set(null),
      });
  }

  private startSync(): void {
    this.stopSync();
    this.syncSubscription = interval(SYNC_INTERVAL_MS)
      .pipe(
        filter(() => !this.refreshing()),
        exhaustMap(() => this.fetchLatest$()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private stopSync(): void {
    this.syncSubscription?.unsubscribe();
    this.syncSubscription = undefined;
  }

  private fetchLatest$(): Observable<unknown> {
    const groupId = this.invite()?.GroupReservationId;
    if (!groupId) {
      return EMPTY;
    }
    const version = this.dataVersion;
    this.refreshing.set(true);

    return forkJoin({
      sessions: this.service.getSessions$(groupId, { silent: true }),
      status: this.service.getStatus$(groupId, { silent: true }),
    }).pipe(
      tap(({ sessions, status }) => {
        if (version !== this.dataVersion) {
          return;
        }
        this.applyLatest(sessions, status);
        if (!this.isOpen()) {
          this.stopSync();
        }
      }),
      catchError(() => {
        this.refreshFailed.set(true);
        return EMPTY;
      }),
      finalize(() => this.refreshing.set(false)),
    );
  }

  private applyLatest(sessions: GroupSessionsResponse, status: GroupStatusResponse): void {
    this.participants.set(sessions.participants);
    this.status.set(status.status);
    this.lastUpdated.set(new Date());
    this.refreshFailed.set(false);
  }
}
