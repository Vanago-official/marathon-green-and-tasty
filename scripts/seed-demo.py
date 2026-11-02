#!/usr/bin/env python3
"""Fills an empty deployment with demo data: locations, tables, dishes and one waiter per location.

Safe to run again: ids are fixed, and existing waiter accounts are reused.
Usage: API_URL=... USER_POOL_ID=... python3 scripts/seed-demo.py <credentials-output-file>
"""
import json
import os
import secrets
import subprocess
import sys
import urllib.error
import urllib.request

API = os.environ["API_URL"].rstrip("/")
POOL = os.environ["USER_POOL_ID"]
AWS = [os.environ.get("AWS_CLI", "aws"), "--region", os.environ.get("AWS_REGION", "eu-north-1")]

LOCATIONS = [
    ("demo-loc-rustaveli", "48 Rustaveli Avenue", "rustaveli-avenue-48.jpg", 4.8, "In the heart of the city: seasonal plates and a bright dining room."),
    ("demo-loc-baratashvili", "14 Baratashvili Street", "baratashvili-street-14.jpg", 4.6, "A cosy corner in the old town with a garden terrace."),
    ("demo-loc-abashidze", "9 Abashidze Street", "abashidze-street-9.jpg", 4.7, "Quiet neighbourhood spot, loved for long family dinners."),
]
DISHES = [
    ("Avocado Pine Nut Bowl", "avocado-pine-nut-bowl.jpg", 14, 1, "Avocado, pine nuts, quinoa and greens with a lemon dressing."),
    ("Spring Salad", "spring-salad.jpg", 9, 0, "Crisp seasonal leaves, radish and fresh herbs."),
    ("Strawberry Mint Salad", "fresh-strawberry-mint-salad.jpg", 10, 2, "Fresh strawberries, mint and a light honey glaze."),
    ("Sweet Potato and Lentil Salad", "roasted-sweet-potato-and-lentil-salad.jpg", 13, 1, "Roasted sweet potato, green lentils and tahini."),
]
TABLES = [(1, 2), (2, 4), (3, 6), (4, 8)]


def aws(*args):
    return subprocess.run(AWS + list(args), check=True, capture_output=True, text=True).stdout


def put(table, item):
    aws("dynamodb", "put-item", "--table-name", table, "--item", json.dumps(item))


def S(v):
    return {"S": v}


def N(v):
    return {"N": str(v)}


def post(path, body):
    request = urllib.request.Request(API + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, {}


def waiter_for(location_id, number):
    email = f"gt-waiter{number}@example.com"
    password = "Wt-" + secrets.token_hex(5) + "!"
    status, _ = post("/register", {"firstName": ("Anna", "Mark", "Nina")[number - 1], "lastName": "Waiter", "email": email, "password": password, "confirmPassword": password})
    if status == 409:
        password = None  # Already registered: keep the password issued earlier.
    elif status != 200:
        raise RuntimeError(f"register {email}: {status}")
    users = json.loads(aws("cognito-idp", "list-users", "--user-pool-id", POOL, "--filter", f'email = "{email}"'))["Users"]
    user_id = next(a["Value"] for a in users[0]["Attributes"] if a["Name"] == "sub")
    try:
        aws("cognito-idp", "create-group", "--user-pool-id", POOL, "--group-name", "Waiter")
    except subprocess.CalledProcessError as error:
        if "GroupExists" not in error.stderr:
            raise
    aws("cognito-idp", "admin-add-user-to-group", "--user-pool-id", POOL, "--username", email, "--group-name", "Waiter")
    if aws("dynamodb", "get-item", "--table-name", "Waiters", "--key", json.dumps({"userId": S(user_id)})).strip() == "":
        put("Waiters", {"userId": S(user_id), "locationId": S(location_id), "createdAt": S("2026-11-01T00:00:00.000Z"), "reservations": {"L": []}})
    return email, password


def main(credentials_path):
    credentials = []
    for number, (location_id, address, image, rating, description) in enumerate(LOCATIONS, 1):
        dish_ids = []
        for index, (name, dish_image, price, dish_type, about) in enumerate(DISHES, 1):
            dish_id = f"{location_id}-dish-{index}"
            dish_ids.append(dish_id)
            put("Dishes", {
                "id": S(dish_id), "name": S(name), "description": S(about), "dishType": N(dish_type), "price": N(price),
                "weight": S("300 g"), "calories": S("320 kcal"), "proteins": S("11 g"), "fats": S("14 g"),
                "carbohydrates": S("38 g"), "vitamins": S("A, C, E"), "imageUrl": S(f"assets/img/dishes/{dish_image}"),
                "state": N(1), "locationId": S(location_id),
            })
        put("Locations", {
            "id": S(location_id), "address": S(address), "description": S(description),
            "totalCapacity": N(sum(c for _, c in TABLES)), "averageOccupancy": S("72%"),
            "imageUrl": S(f"assets/img/locations/{image}"), "rating": N(rating),
            "specialtyDishIds": {"L": [S(d) for d in dish_ids[:2]]},
        })
        for table_number, capacity in TABLES:
            put("Tables", {"id": S(f"{location_id}-table-{table_number}"), "locationId": S(location_id), "capacity": N(capacity), "tableNumber": N(table_number)})
        credentials.append((address, *waiter_for(location_id, number)))

    fresh = [c for c in credentials if c[2]]
    if fresh:
        descriptor = os.open(credentials_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(descriptor, "w") as output:
            for address, email, password in fresh:
                output.write(f"{address}: {email} / {password}\n")
    print(f"Seeded {len(LOCATIONS)} locations, {len(fresh)} new waiter accounts.")


if __name__ == "__main__":
    main(sys.argv[1])
