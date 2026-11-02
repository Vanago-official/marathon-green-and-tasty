using APIHandler.Constants;
using APIHandler.Constants.Dishes;
using APIHandler.Entities;
using APIHandler.Exceptions;
using APIHandler.Models.GuestSessions;
using APIHandler.Repositories.Auth;
using APIHandler.Repositories.Dishes;
using APIHandler.Repositories.GroupReservations;
using APIHandler.Repositories.GuestSessions;
using APIHandler.Repositories.Orders;
using APIHandler.Repositories.Reservations;
using APIHandler.Repositories.Tables;
using APIHandler.Services.GuestSessions;
using AutoFixture;
using Moq;

namespace APIHandler.Tests.Services;

public class GroupPreOrderOwnerTests
{
    private const string OwnerId = "owner";
    private const string GroupId = "group";
    private const string ReservationId = "reservation";

    private readonly Mock<IGuestSessionRepository> _sessions = new();
    private readonly Mock<IGroupReservationRepository> _groups = new();
    private readonly Mock<IDishRepository> _dishes = new();
    private readonly Mock<IReservationRepository> _reservations = new();
    private readonly Mock<IOrderRepository> _orders = new();
    private readonly GuestSessionService _service;
    private readonly GroupReservation _group;
    private readonly Fixture _fixture = new();

    public GroupPreOrderOwnerTests()
    {
        _service = new GuestSessionService(
            _groups.Object,
            _sessions.Object,
            _dishes.Object,
            _reservations.Object,
            new Mock<IUserRepository>().Object,
            new Mock<ITableRepository>().Object,
            _orders.Object);

        _group = new GroupReservation
        {
            GroupReservationId = GroupId,
            ReservationId = ReservationId,
            ReservationToken = "token",
            Status = GroupReservationStatus.Open
        };

        var reservation = _fixture.Build<Reservation>()
            .With(r => r.Id, ReservationId)
            .With(r => r.CustomerId, OwnerId)
            .Create();

        _groups.Setup(r => r.GetGroupReservationByIdAsync(GroupId)).ReturnsAsync(_group);
        _groups.Setup(r => r.GetByReservationIdAsync(ReservationId)).ReturnsAsync(_group);
        _reservations.Setup(r => r.GetReservationByIdAsync(ReservationId)).ReturnsAsync(reservation);
    }

    private static GuestSession Session(string id, bool submitted, params (string Dish, int Quantity)[] dishes) => new()
    {
        Id = id,
        GroupReservationId = GroupId,
        GuestName = id,
        IsSubmitted = submitted,
        Dishes = dishes.Select(d => new OrderItem { DishId = d.Dish, Quantity = d.Quantity }).ToList()
    };

    private void SetupSessions(params GuestSession[] sessions) =>
        _sessions.Setup(r => r.GetAllByGroupReservationIdAsync(GroupId)).ReturnsAsync(sessions.ToList());

    private Order SetupOrder(params OrderItem[] dishes)
    {
        var order = _fixture.Build<Order>()
            .With(o => o.Dishes, dishes.ToList())
            .With(o => o.Status, OrderStatus.Created)
            .Create();
        _orders.Setup(r => r.GetOrderByReservationIdAsync(ReservationId)).ReturnsAsync(order);
        return order;
    }

    [Fact]
    public async Task GetGroupSessions_ReturnsParticipantsAndTotals()
    {
        SetupSessions(Session("andrii", true, ("dish1", 2)), Session("olena", false, ("dish2", 1)));
        _dishes.Setup(r => r.GetDishesByIdsAsync(It.IsAny<IEnumerable<string>>())).ReturnsAsync(
        [
            _fixture.Build<Dish>().With(d => d.Id, "dish1").With(d => d.Price, 180m).Create(),
            _fixture.Build<Dish>().With(d => d.Id, "dish2").With(d => d.Price, 220m).Create(),
        ]);

        var result = await _service.GetGroupSessionsAsync(OwnerId, GroupId);

        Assert.Equal(580m, result.Total);
        Assert.Equal([360m, 220m], result.Participants.Select(p => p.Total));
        Assert.All(result.Participants, p => Assert.Equal(ParticipantType.Guest, p.Type));
    }

    [Fact]
    public async Task GetGroupSessions_NotOwner_ThrowsForbidden() =>
        await Assert.ThrowsAsync<ActionForbiddenException>(() => _service.GetGroupSessionsAsync("stranger", GroupId));

    [Fact]
    public async Task GetOwnerSessionId_NoSession_CreatesOwnerSession()
    {
        SetupSessions();

        var result = await _service.GetOwnerSessionIdAsync(OwnerId, ReservationId);

        _sessions.Verify(r => r.SaveAsync(It.Is<GuestSession>(s => s.Id == result.GuestSessionId && s.IsOwnerSession && s.OwnerUserId == OwnerId)), Times.Once);
    }

    [Fact]
    public async Task GetOwnerSessionId_SessionExists_ReturnsItWithoutCreating()
    {
        var owner = Session("owner-session", false);
        owner.IsOwnerSession = true;
        SetupSessions(Session("guest", false), owner);

        var result = await _service.GetOwnerSessionIdAsync(OwnerId, ReservationId);

        Assert.Equal("owner-session", result.GuestSessionId);
        _sessions.Verify(r => r.SaveAsync(It.IsAny<GuestSession>()), Times.Never);
    }

    [Fact]
    public async Task GetOwnerSessionId_ReservationMissing_ThrowsNotFound() =>
        await Assert.ThrowsAsync<ReservationNotFoundException>(() => _service.GetOwnerSessionIdAsync(OwnerId, "missing"));

    [Fact]
    public async Task GetOwnerSessionId_NotOwner_ThrowsForbidden() =>
        await Assert.ThrowsAsync<ActionForbiddenException>(() => _service.GetOwnerSessionIdAsync("stranger", ReservationId));

    [Fact]
    public async Task Submit_MergesOnlySubmittedSessionsAndUpdatesStatuses()
    {
        SetupSessions(
            Session("a", true, ("dish1", 2), ("dish2", 1)),
            Session("b", true, ("dish1", 1), ("dish2", 1)),
            Session("c", false, ("dish1", 50)));
        var order = SetupOrder(new OrderItem { DishId = "dish1", Quantity = 1 });

        var result = await _service.SubmitGroupPreOrderAsync(OwnerId, GroupId, ReservationId);

        Assert.Equal([new ConsolidatedOrderItem("dish1", 3), new ConsolidatedOrderItem("dish2", 2)], result);
        Assert.Equal(4, order.Dishes.Single(d => d.DishId == "dish1").Quantity);
        Assert.Equal(2, order.Dishes.Single(d => d.DishId == "dish2").Quantity);
        Assert.Equal(OrderStatus.SubmittedByCustomer, order.Status);
        Assert.Equal(GroupReservationStatus.Submitted, _group.Status);
        _orders.Verify(r => r.SaveOrderAsync(order), Times.Once);
        _groups.Verify(r => r.SaveGroupReservationAsync(_group), Times.Once);
    }

    [Fact]
    public async Task Submit_NoSubmittedSessions_ThrowsValidation()
    {
        SetupSessions(Session("a", false, ("dish1", 1)));
        await Assert.ThrowsAsync<ValidationException>(() => _service.SubmitGroupPreOrderAsync(OwnerId, GroupId, ReservationId));
    }

    [Fact]
    public async Task Submit_SubmittedSessionsWithoutDishes_ThrowsValidation()
    {
        SetupSessions(Session("a", true));
        await Assert.ThrowsAsync<ValidationException>(() => _service.SubmitGroupPreOrderAsync(OwnerId, GroupId, ReservationId));
    }

    [Fact]
    public async Task Submit_OrderMissing_ThrowsValidationAndChangesNothing()
    {
        SetupSessions(Session("a", true, ("dish1", 1)));

        await Assert.ThrowsAsync<ValidationException>(() => _service.SubmitGroupPreOrderAsync(OwnerId, GroupId, ReservationId));

        Assert.Equal(GroupReservationStatus.Open, _group.Status);
        _groups.Verify(r => r.SaveGroupReservationAsync(It.IsAny<GroupReservation>()), Times.Never);
    }

    [Fact]
    public async Task Submit_GroupMissing_ThrowsNotFound() =>
        await Assert.ThrowsAsync<GroupReservationNotFoundException>(() => _service.SubmitGroupPreOrderAsync(OwnerId, "missing", ReservationId));

    [Fact]
    public async Task Submit_NotOwner_ThrowsForbidden() =>
        await Assert.ThrowsAsync<ActionForbiddenException>(() => _service.SubmitGroupPreOrderAsync("stranger", GroupId, ReservationId));

    [Fact]
    public async Task Delete_ReturnsUpdatedSnapshot()
    {
        var removed = Session("a", false);
        _sessions.Setup(r => r.GetByGuestSessionId("a")).ReturnsAsync(removed);
        SetupSessions(Session("b", false));

        var result = await _service.DeleteGuestSessionAsync(OwnerId, GroupId, "a");

        _sessions.Verify(r => r.DeleteAsync(removed), Times.Once);
        Assert.Equal("b", result.Participants.Single().Id);
    }

    [Fact]
    public async Task Delete_SessionFromAnotherGroup_ThrowsValidation()
    {
        var session = Session("a", false);
        session.GroupReservationId = "other";
        _sessions.Setup(r => r.GetByGuestSessionId("a")).ReturnsAsync(session);

        await Assert.ThrowsAsync<ValidationException>(() => _service.DeleteGuestSessionAsync(OwnerId, GroupId, "a"));
    }

    [Fact]
    public async Task Delete_SessionMissing_ThrowsNotFound() =>
        await Assert.ThrowsAsync<GuestSessionNotFoundException>(() => _service.DeleteGuestSessionAsync(OwnerId, GroupId, "missing"));

    [Fact]
    public async Task Delete_OwnerSession_ThrowsValidation()
    {
        var owner = Session("owner-session", false);
        owner.IsOwnerSession = true;
        _sessions.Setup(r => r.GetByGuestSessionId("owner-session")).ReturnsAsync(owner);

        await Assert.ThrowsAsync<ValidationException>(() => _service.DeleteGuestSessionAsync(OwnerId, GroupId, "owner-session"));
        _sessions.Verify(r => r.DeleteAsync(It.IsAny<GuestSession>()), Times.Never);
    }
}
