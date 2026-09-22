import argparse
import asyncio
import signal
import sys
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from ..commands.convert import convert
from ..commands.pull import pull
from ..socrata.client import API_ROOT, Dataset, open_client
from ..storage.raw_manifest import RawManifestStorage
from ..storage.raw_pages import RawPageStorage

DATASETS = (
    Dataset("recent", "qzsc-9esp"),
    Dataset("historical", "w9zh-vetq"),
)


@dataclass(frozen=True)
class PullOptions:
    raw_path: Path
    api_root: str


@dataclass(frozen=True)
class ConvertOptions:
    raw_path: Path
    parquet_path: Path


Command = Callable[[argparse.Namespace], Awaitable[int]]


def main(argv: Sequence[str] | None = None) -> None:
    args = parser().parse_args(argv)
    command: Command = args.command
    exit_code = asyncio.run(command(args))
    if exit_code:
        raise SystemExit(exit_code)


def parser() -> argparse.ArgumentParser:
    command = argparse.ArgumentParser(prog="lending-interest-rates")
    subcommands = command.add_subparsers(required=True)
    pull_parser = subcommands.add_parser("pull", help="pull raw Socrata data")
    pull_parser.set_defaults(command=run_pull_command)
    pull_parser.add_argument("--raw-path", type=Path, default=Path("data/raw"))
    pull_parser.add_argument("--api-root", default=API_ROOT, help=argparse.SUPPRESS)
    convert_parser = subcommands.add_parser(
        "convert", help="convert raw data to Parquet"
    )
    convert_parser.set_defaults(command=run_convert_command)
    convert_parser.add_argument("--raw-path", type=Path, default=Path("data/raw"))
    convert_parser.add_argument(
        "--parquet-path", type=Path, default=Path("data/parquet")
    )
    return command


async def run_convert_command(args: argparse.Namespace) -> int:
    return run_convert(ConvertOptions(args.raw_path, args.parquet_path))


def run_convert(options: ConvertOptions) -> int:
    convert(
        raw_path=options.raw_path,
        parquet_path=options.parquet_path,
        progress=report_progress,
    )
    log("COMPLETE", manifest=options.parquet_path / "manifest.json")
    return 0


async def run_pull_command(args: argparse.Namespace) -> int:
    return await run_pull(PullOptions(args.raw_path, args.api_root))


async def run_pull(options: PullOptions) -> int:
    task = asyncio.current_task()
    assert task is not None
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, task.cancel, signum)

    try:
        async with open_client(api_root=options.api_root) as socrata:
            datasets = {dataset.name: dataset for dataset in DATASETS}
            await pull(
                historical=datasets["historical"],
                recent=datasets["recent"],
                socrata=socrata,
                raw_pages=RawPageStorage(options.raw_path),
                manifest_storage=RawManifestStorage(options.raw_path / "manifest.json"),
                progress=report_progress,
            )
    except asyncio.CancelledError as error:
        if not error.args or not isinstance(error.args[0], signal.Signals):
            raise
        received_signal = error.args[0]
        log("INTERRUPTED", signal=received_signal.name)
        return 128 + received_signal.value
    finally:
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(signum)

    log("COMPLETE", manifest=options.raw_path / "manifest.json")
    return 0


def report_progress(event: str, values: dict[str, object]) -> None:
    log(event, **values)


def log(event: str, **values: object) -> None:
    fields = " ".join(f"{name}={value}" for name, value in values.items())
    print(f"{event} {fields}".rstrip(), file=sys.stderr, flush=True)
