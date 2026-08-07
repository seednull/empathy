#include <empathy.h>

#include <cassert>
#include <cstdint>
#include <iostream>
#include <limits>

enum AtomType : uint32_t
{
	ATOM_TYPE_LINE = 0,
	ATOM_TYPE_CHARACTER,
	ATOM_TYPE_CHOICE,
};

enum YieldType : uint32_t
{
	YIELD_TYPE_LINE = 0,
	YIELD_TYPE_CHOICE,
	YIELD_TYPE_SAY,
};

static const char *lines[] =
{
	"Rain erased the road behind the last train.",
	"The signal tower is still lit.",
	"Then either someone is waiting, or someone forgot to leave.",
	"Mara climbs the iron stairs while the tower sways in the wind.",
	"The lamp is warm. Whoever lit it cannot be far.",
	"Ilya follows the fresh footprints along the flooded platform.",
	"They turn back toward the station. We are being led in a circle.",
	"Both trails end at the locked waiting room.",
	"You took your time.",
	"We took the scenic route.",
	"Inside, the station clock begins to move again.",
};

static const char *characters[] =
{
	"Mara",
	"Ilya",
	"Keeper",
};

static const char *choices[] =
{
	"Climb to the signal room",
	"Follow the footprints",
};

static void handleLine(Empathy_Instance instance, Empathy_Machine machine)
{
	uint32_t stack_size = 0;
	Empathy_Result result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size == 1);

	Empathy_Value line = {};
	result = empathyYieldStackPeek(instance, machine, 0, &line);
	assert(result == EMPATHY_SUCCESS);
	assert(line.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(line.type.atom_type == ATOM_TYPE_LINE);
	assert(line.data.atom.type == ATOM_TYPE_LINE);
	assert(line.data.atom.value < sizeof(lines) / sizeof(lines[0]));

	std::cout << "\n" << lines[line.data.atom.value] << "\n";

	result = empathyYieldStackPop(instance, machine, &line);
	assert(result == EMPATHY_SUCCESS);
}

static void handleChoice(Empathy_Instance instance, Empathy_Machine machine)
{
	Empathy_Value count_value = {};
	Empathy_Result result = empathyYieldStackPeek(instance, machine, 0, &count_value);
	assert(result == EMPATHY_SUCCESS);
	assert(count_value.type.base_type == EMPATHY_VALUE_BASE_TYPE_UINT32);

	uint32_t count = count_value.data.u32;
	assert(count > 0);

	uint32_t stack_size = 0;
	result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size == count + 1);

	std::cout << "\n";
	for (uint32_t i = 0; i < count; ++i)
	{
		Empathy_Value choice = {};
		result = empathyYieldStackPeek(instance, machine, count - i, &choice);
		assert(result == EMPATHY_SUCCESS);
		assert(choice.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
		assert(choice.type.atom_type == ATOM_TYPE_CHOICE);
		assert(choice.data.atom.type == ATOM_TYPE_CHOICE);
		assert(choice.data.atom.value < sizeof(choices) / sizeof(choices[0]));
		std::cout << "  " << i + 1 << ". " << choices[choice.data.atom.value] << "\n";
	}

	for (uint32_t i = 0; i < stack_size; ++i)
	{
		Empathy_Value value = {};
		result = empathyYieldStackPop(instance, machine, &value);
		assert(result == EMPATHY_SUCCESS);
	}

	Empathy_Value response = {};
	response.type.base_type = EMPATHY_VALUE_BASE_TYPE_UINT32;

	for (;;)
	{
		std::cout << "> ";

		uint32_t selection = 0;
		if (std::cin >> selection)
		{
			if (selection > 0 && selection <= count)
			{
				response.data.u32 = selection - 1;
				break;
			}
		}
		else if (std::cin.eof())
		{
			std::cout << "No input available; choosing option 1.\n";
			break;
		}

		std::cin.clear();
		std::cin.ignore(std::numeric_limits<std::streamsize>::max(), '\n');
		std::cout << "Choose a number from 1 to " << count << ".\n";
	}

	result = empathyYieldStackPush(instance, machine, response);
	assert(result == EMPATHY_SUCCESS);
}

static void handleSay(Empathy_Instance instance, Empathy_Machine machine)
{
	uint32_t stack_size = 0;
	Empathy_Result result = empathyGetYieldStackSize(instance, machine, &stack_size);
	assert(result == EMPATHY_SUCCESS);
	assert(stack_size == 2);

	Empathy_Value line = {};
	result = empathyYieldStackPeek(instance, machine, 1, &line);
	assert(result == EMPATHY_SUCCESS);
	assert(line.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(line.type.atom_type == ATOM_TYPE_LINE);
	assert(line.data.atom.type == ATOM_TYPE_LINE);
	assert(line.data.atom.value < sizeof(lines) / sizeof(lines[0]));

	Empathy_Value character = {};
	result = empathyYieldStackPeek(instance, machine, 0, &character);
	assert(result == EMPATHY_SUCCESS);
	assert(character.type.base_type == EMPATHY_VALUE_BASE_TYPE_ATOM);
	assert(character.type.atom_type == ATOM_TYPE_CHARACTER);
	assert(character.data.atom.type == ATOM_TYPE_CHARACTER);
	assert(character.data.atom.value < sizeof(characters) / sizeof(characters[0]));

	std::cout << characters[character.data.atom.value] << ": " << lines[line.data.atom.value] << "\n";

	result = empathyYieldStackPop(instance, machine, &character);
	assert(result == EMPATHY_SUCCESS);
	result = empathyYieldStackPop(instance, machine, &line);
	assert(result == EMPATHY_SUCCESS);
}

static void runStory(Empathy_Instance instance)
{
	Empathy_AtomTypeDesc atom_types[] =
	{
		{ATOM_TYPE_LINE, 0, static_cast<uint32_t>(sizeof(lines) / sizeof(lines[0])) - 1},
		{ATOM_TYPE_CHARACTER, 0, static_cast<uint32_t>(sizeof(characters) / sizeof(characters[0])) - 1},
		{ATOM_TYPE_CHOICE, 0, static_cast<uint32_t>(sizeof(choices) / sizeof(choices[0])) - 1},
	};

	// line   -> line atom
	// choice -> choice atoms..., uint32 count; resumes with a uint32 selected index
	// say    -> line atom, character atom
	Empathy_ValueType choice_resume_types[] =
	{
		{EMPATHY_VALUE_BASE_TYPE_UINT32, 0},
	};

	Empathy_YieldDesc yields[] =
	{
		{0, nullptr},
		{1, choice_resume_types},
		{0, nullptr},
	};

	Empathy_ProgramLayoutDesc layout_desc =
	{
		3, atom_types,
		0, nullptr,
		3, yields,
	};

	Empathy_ProgramLayout layout = EMPATHY_NULL_HANDLE;
	Empathy_Result result = empathyCreateProgramLayout(instance, &layout_desc, &layout);
	assert(result == EMPATHY_SUCCESS);

	/*
	 * 000: line line[0]
	 * 014: say  line[1], character[0]
	 * 037: say  line[2], character[1]
	 * 060: choice [choice[0], choice[1]], 2
	 * 088: take selected index; jump to 150 unless it is zero
	 * 104: line line[3]
	 * 118: say  line[4], character[0]
	 * 141: jump to shared section at 187
	 * 150: line line[5]
	 * 164: say  line[6], character[1]
	 * 187: line line[7]
	 * 201: say  line[8], character[2]
	 * 224: say  line[9], character[0]
	 * 247: line line[10]
	 * 261: end
	 */
	const uint8_t payload[] =
	{
		// line line[0]
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2F, 0x00, 0x00, 0x00, 0x00,

		// say line[1], character[0]
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,

		// say line[2], character[1]
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,

		// choice [choice[0], choice[1]], 2
		0x2A, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2A, 0x02, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x22, 0x02, 0x00, 0x00, 0x00,
		0x2F, 0x01, 0x00, 0x00, 0x00,

		// if (selected index != 0) jump to the second branch at 150
		0x2E,
		0x02, 0x00, 0x00, 0x00, 0x00,
		0x13,
		0x1A, 0x96, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,

		// First branch: signal room
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00,
		0x2F, 0x00, 0x00, 0x00, 0x00,
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,
		0x19, 0xBB, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,

		// Second branch: footprints
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x05, 0x00, 0x00, 0x00,
		0x2F, 0x00, 0x00, 0x00, 0x00,
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,

		// Shared ending
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x07, 0x00, 0x00, 0x00,
		0x2F, 0x00, 0x00, 0x00, 0x00,
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00,
		0x2A, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x2F, 0x02, 0x00, 0x00, 0x00,
		0x2A, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00,
		0x2F, 0x00, 0x00, 0x00, 0x00,
		0x30,
	};

	Empathy_ProgramEntryPointDesc entries[] =
	{
		{0, EMPATHY_PROGRAM_OFFSET_NONE},
	};

	Empathy_ProgramDesc program_desc =
	{
		layout,
		1, entries,
		sizeof(payload), payload,
	};

	Empathy_Program program = EMPATHY_NULL_HANDLE;
	result = empathyCreateProgram(instance, &program_desc, &program);
	assert(result == EMPATHY_SUCCESS);

	Empathy_MachineDesc machine_desc =
	{
		16,
		16,
		8,
		0,
		1024,
	};

	Empathy_Machine machine = EMPATHY_NULL_HANDLE;
	result = empathyCreateMachine(instance, &machine_desc, &machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindProgram(instance, machine, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyBindProgramEntryPoint(instance, machine, 0);
	assert(result == EMPATHY_SUCCESS);

	for (;;)
	{
		result = empathyRun(instance, machine);
		if (result == EMPATHY_EXECUTION_END)
			break;

		assert(result == EMPATHY_EXECUTION_YIELD);

		uint32_t yield_index = 0;
		result = empathyGetYieldIndex(instance, machine, &yield_index);
		assert(result == EMPATHY_SUCCESS);

		switch (yield_index)
		{
			case YIELD_TYPE_LINE: handleLine(instance, machine); break;
			case YIELD_TYPE_CHOICE: handleChoice(instance, machine); break;
			case YIELD_TYPE_SAY: handleSay(instance, machine); break;
			default: assert(false); break;
		}
	}

	result = empathyDestroyMachine(instance, machine);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgram(instance, program);
	assert(result == EMPATHY_SUCCESS);

	result = empathyDestroyProgramLayout(instance, layout);
	assert(result == EMPATHY_SUCCESS);
}

int main()
{
	Empathy_Instance instance = EMPATHY_NULL_HANDLE;
	Empathy_InstanceDesc instance_desc = {};

	Empathy_Result result = empathyCreateInstance(&instance_desc, &instance);
	assert(result == EMPATHY_SUCCESS);

	runStory(instance);

	result = empathyDestroyInstance(instance);
	assert(result == EMPATHY_SUCCESS);

	return 0;
}
