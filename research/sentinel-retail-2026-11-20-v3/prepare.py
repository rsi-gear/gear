"""Authored synthetic retail tasks; reference actions execute in the pinned native environment."""

import argparse
import copy
import json
import sys
from pathlib import Path
from types import SimpleNamespace

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--repository", type=Path, required=True)
parser.add_argument("--tau2-source", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
ROOT = args.repository.resolve()
sys.path[:0] = [str(ROOT / "python"), str(ROOT / "examples/curriculum-harness")]
from gear.canonical import digest  # noqa: E402
from sentinel_generate import EXPLORER_PROMPT, freeze  # noqa: E402
from sentinel_retail import RetailSession, build_task, calibrate, load_backend  # noqa: E402

OUT = args.output.resolve()
SOURCE = args.tau2_source.resolve()
backend = load_backend(SOURCE)


def database(label):
    uid = label + "_customer"
    address = dict(
        address1="10 Example Way",
        address2="",
        city="Example City",
        country="USA",
        state="NY",
        zip="10000",
    )
    item = dict(
        name="Example shirt",
        product_id=label + "-shirt",
        item_id=label + "-blue-m",
        price=10.0,
        options={"color": "blue", "size": "M"},
    )
    orders = {}
    for suffix, status, quantity in [
        ("100", "pending", 2),
        ("101", "delivered", 2),
        ("102", "pending", 1),
    ]:
        oid = "#" + label + suffix
        orders[oid] = dict(
            order_id=oid,
            user_id=uid,
            address=copy.deepcopy(address),
            items=[copy.deepcopy(item) for _ in range(quantity)],
            status=status,
            fulfillments=[],
            payment_history=[
                dict(
                    transaction_type="payment",
                    amount=10.0 * quantity,
                    payment_method_id=label + "-original",
                )
            ],
        )
    user = dict(
        user_id=uid,
        name={"first_name": label, "last_name": "Example"},
        address=address,
        email=label.lower() + "@gear.example",
        orders=list(orders),
        payment_methods={
            label + "-" + kind: dict(
                source="credit_card", id=label + "-" + kind, brand="visa", last_four=digits
            )
            for kind, digits in [("original", "0000"), ("alternate", "1111")]
        },
    )
    variants = {
        label + "-" + name: dict(
            item_id=label + "-" + name,
            options={"color": color, "size": size},
            available=True,
            price=price,
        )
        for name, color, size, price in [
            ("blue-m", "blue", "M", 10.0),
            ("red-l", "red", "L", 12.0),
            ("green-l", "green", "L", 13.0),
        ]
    }
    return dict(
        users={uid: user},
        orders=orders,
        products={
            label + "-shirt": dict(
                name="Example shirt", product_id=label + "-shirt", variants=variants
            )
        },
    )


def bundle(label, partition, family, name, *, color=None, address=False, payment=False, extra=None):
    db = database(label)
    uid = label + "_customer"
    oid = "#" + label + "100"
    move = dict(
        address1="20 Practice Lane",
        address2="",
        city="Example City",
        country="USA",
        state="NY",
        zip="10001",
    )
    goals = []
    writes = []
    if address:
        goals.append(
            "ship order "
            + oid
            + " to 20 Practice Lane, Example City, NY 10001, USA, with no apartment"
        )
        writes.append(
            (
                "modify_pending_order_address",
                dict(order_id=oid, **move),
                "change the shipping address of "
                + oid
                + " to 20 Practice Lane, Example City, NY 10001, USA, no apartment",
            )
        )
    if payment:
        goals.append(
            "pay for order " + oid + " using my Visa ending 1111 instead of Visa ending 0000"
        )
        writes.append(
            (
                "modify_pending_order_payment",
                dict(order_id=oid, payment_method_id=label + "-alternate"),
                "charge the full $20 order total to Visa 1111 and refund the original $20 to Visa 0000 within 5 to 7 business days",
            )
        )
    if color:
        price = 12 if color == "red" else 13
        card = "alternate" if payment else "original"
        goals.append(
            "change BOTH blue medium shirts in "
            + oid
            + " to "
            + color
            + " size L, paying the $"
            + str((price - 10) * 2)
            + " difference on Visa "
            + ("1111" if payment else "0000")
        )
        writes.append(
            (
                "modify_pending_order_items",
                dict(
                    order_id=oid,
                    item_ids=[label + "-blue-m"] * 2,
                    new_item_ids=[label + "-" + color + "-l"] * 2,
                    payment_method_id=label + "-" + card,
                ),
                "change both blue M shirts to "
                + color
                + " L, total $"
                + str(price * 2)
                + ", paying the $"
                + str((price - 10) * 2)
                + " difference with Visa "
                + ("1111" if payment else "0000")
                + ". These are all requested item changes, and further changes or cancellation to this order will no longer be available",
            )
        )
    if extra == "return":
        other = "#" + label + "101"
        goals.append(
            "return BOTH shirts from delivered order "
            + other
            + " with the refund going to original Visa 0000"
        )
        writes.append(
            (
                "return_delivered_order_items",
                dict(
                    order_id=other,
                    item_ids=[label + "-blue-m"] * 2,
                    payment_method_id=label + "-original",
                ),
                "request return of both shirts from "
                + other
                + ", $20 refund to original Visa 0000; return instructions will arrive by email",
            )
        )
    elif extra == "cancel":
        other = "#" + label + "102"
        goals.append("cancel pending order " + other + " because it is no longer needed")
        writes.append(
            (
                "cancel_pending_order",
                dict(order_id=other, reason="no longer needed"),
                "cancel "
                + other
                + " because it is no longer needed, refunding $10 to original Visa 0000 in 5 to 7 business days",
            )
        )
    opening = "Please " + "; and ".join(goals) + "."
    goal = (
        "You are "
        + label
        + " Example ("
        + label.lower()
        + "@gear.example). You want to "
        + "; and ".join(goals)
        + ". Keep all other orders and your default profile address unchanged. You know the details in your own customer profile. You do not want any additional changes."
    )
    session = RetailSession(backend, db, uid)
    trace = dict(
        schema_version=1,
        environment_id=session.identity,
        initial=session.initial,
        goal=goal,
        opening=opening,
        steps=[],
        status="incomplete",
        final=session.snapshot(),
    )

    def tool(name, arguments):
        action = dict(name=name, arguments=arguments)
        result = session.execute(action, len(trace["steps"]))
        if result["response"].get("error"):
            raise ValueError(result["response"])
        trace["steps"].append(dict(kind="tool", action=action, execution=result))
        trace["final"] = session.snapshot()

    tool("find_user_id_by_email", {"email": label.lower() + "@gear.example"})
    tool("get_user_details", {"user_id": uid})
    for target in sorted({arguments["order_id"] for _, arguments, _ in writes}):
        tool("get_order_details", {"order_id": target})
    if color:
        tool("get_product_details", {"product_id": label + "-shirt"})
    for action, arguments, explanation in writes:
        trace["steps"].append(
            dict(
                kind="message",
                text="Please confirm: " + explanation + ".",
                reply="Yes, I confirm exactly those details.",
            )
        )
        tool(action, arguments)
    trace["steps"].append(
        dict(
            kind="finish",
            text="The requested changes are complete. All other orders and your profile address are unchanged.",
        )
    )
    trace["status"] = "completed"
    task = build_task(
        SimpleNamespace(draft_id=name, instruction=opening, data={"user_instructions": goal}), trace
    )
    calibration = calibrate(backend, db, uid, trace, task)
    freeze(
        OUT / "authored" / (name + ".json"),
        {"task": task.model_dump(mode="json"), "reference": trace, "calibration": calibration},
    )
    return dict(
        partition=partition,
        family=family,
        database=db,
        user_id=uid,
        task=task.model_dump(mode="json"),
        reference=trace,
        evidence_refs=[
            {
                "source": "prepare.py authored synthetic goal and executed native reference",
                "reference_digest": digest(trace),
                "calibration_digest": digest(calibration),
            }
        ],
    )


train = [
    bundle(
        "T", "train", "pending-combined-edits", "training-address-items", color="red", address=True
    ),
    bundle(
        "T",
        "train",
        "pending-combined-edits",
        "training-payment-items",
        color="green",
        payment=True,
    ),
]
validation = [
    bundle(
        "V",
        "validation",
        "pending-address-payment",
        "development-address-payment",
        address=True,
        payment=True,
    )
]
test = [
    bundle(
        "H",
        "test",
        "multi-order-return-edit",
        "test-return-edit",
        color="green",
        address=True,
        extra="return",
    ),
    bundle(
        "J",
        "test",
        "multi-order-cancel-edit",
        "test-cancel-edit",
        color="red",
        payment=True,
        extra="cancel",
    ),
]
config = dict(
    schema_version=1,
    training={key: train[0][key] for key in ("family", "database", "user_id")},
    validation=validation,
    test=test,
    seeds=[23],
    rounds=1,
    harness=EXPLORER_PROMPT,
    model="gpt-6-luna",
    meta_model="gpt-6-astra",
    effort="low",
    max_steps=24,
    calls_per_task=56,
    calls_per_generation=64,
    calls_per_search=280,
    fixed_count=1,
    generated_count=1,
    generation_attempts=1,
    random_targets=[
        "Make a feasible change to the shipping address and item options of one pending order.",
        "Make a feasible change to the payment method and item options of one pending order.",
    ],
    max_characters=1800,
    target_characters=1400,
    max_repairs=2,
)
config["training"]["fixed"] = [
    {key: row[key] for key in ("task", "reference", "evidence_refs")} for row in train
]
freeze(OUT / "config.json", config)
freeze(
    OUT / "protocol.json",
    {
        "status": "preregistered",
        "source_commit": "6d3959e4f",
        "training": "none",
        "scope": "one paired scheduling seed; concrete tool-use pilot, not statistical or benchmark generalization",
        "authored_references": "Native tools actually executed. No source solver outcomes have been fabricated.",
        "failure_source": "Normal initial retail harness executed on the authored training tasks.",
        "attempts": "Exactly one generation attempt per random/failure arm. No success-conditioned rerolls.",
        "evaluation": "All selections sealed before fixed final tests; retain generation rejections and unknown outcomes.",
        "config_digest": digest(config),
    },
)
print(
    json.dumps({"tasks": len(train) + len(validation) + len(test), "config_digest": digest(config)})
)
