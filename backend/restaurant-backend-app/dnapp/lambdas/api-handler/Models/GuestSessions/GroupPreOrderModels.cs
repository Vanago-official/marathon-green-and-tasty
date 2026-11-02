using System.ComponentModel.DataAnnotations;

namespace APIHandler.Models.GuestSessions;

public record OwnerSessionIdResponse(string GuestSessionId);

public record OwnerSessionTokenResponse(string GuestSessionId, string SessionToken, string GuestName);

public record SubmitGroupPreOrderRequest([property: Required] string ReservationId);

public record ConsolidatedOrderItem(string DishId, int Quantity);
